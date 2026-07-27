/**
 * Adviser — Cloudflare Worker entry point.
 *
 * This file wires all API routes using the **Hono** framework and exports
 * the application as the default Worker handler.
 *
 * ## Middleware
 * - **Rate limiting** (`/api/*`): 20 req/IP/60 s via `RATE_LIMITER`.
 * - **Auth** (`requireAuth`): validates `Authorization: ****** against D1
 *   and populates `userId`, `tenantId`, `email`, `role` context variables.
 * - **Admin guard** (`requireAdmin`): additional check requiring `role === 'admin'`.
 *
 * ## Route groups
 * | Prefix | Description |
 * |--------|-------------|
 * | `/api/auth/*` | Passwordless OTP login / logout |
 * | `/api/terms/*` | Terms & conditions version |
 * | `/api/me` | Authenticated user info |
 * | `/api/feature-flags` | Tenant feature flag map |
 * | `/api/documents` | RAG corpus management (list / ingest / delete) |
 * | `/api/search` | AI-powered normative search |
 * | `/api/history` | Paginated query history |
 * | `/api/companies` | Company profile CRUD |
 * | `/api/tax/*` | Tax period management and AI consolidation |
 * | `/api/portal/*` | DGI/BPS portal automation via Browser Rendering |
 * | `*` | Static Astro frontend assets |
 */

import { Hono, type MiddlewareHandler } from "hono";
import { Anonymizer } from "./services/anonymizer.js";
import { RagService } from "./services/rag.js";
import { AuthService } from "./services/auth.js";
import { EmailService, type SendEmailBinding } from "./services/email.js";
import { FeatureFlagsService } from "./services/featureFlags.js";
import { encryptData, decryptData } from "./services/portalCrypto.js";
import { PortalBrowserService, type Portal, type PortalTask, type PortalCookie } from "./services/portalBrowser.js";

// Bump this string whenever the T&C text changes to force re-acceptance.
const CURRENT_TERMS_VERSION = "1.0";

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Cloudflare Worker bindings available in every request context.
 * All bindings are declared in `wrangler.jsonc`; secrets are set via
 * `wrangler secret put <NAME>`.
 */
interface Bindings {
  /** Cloudflare D1 database — primary relational store. */
  DB: D1Database;
  /** Cloudflare Vectorize index — 1024-dim bge-m3 embeddings for semantic search. */
  VECTORIZE: VectorizeIndex;
  /** Workers AI binding — LLM inference and embedding generation at the edge. */
  AI: Ai;
  /** Static asset fetcher — serves the compiled Astro frontend from `./dist`. */
  ASSETS: Fetcher;
  /** Workers Rate Limiting — 20 req/IP/60 s across all `/api/*` routes. */
  RATE_LIMITER: RateLimit;
  /**
   * Cloudflare Email Send binding (beta).
   * When present, OTP emails are sent via the Workers Email API.
   * If absent, the service falls back to the Resend HTTP API.
   */
  EMAIL_SEND?: SendEmailBinding;
  /**
   * Resend API key — fallback email provider when `EMAIL_SEND` is not configured.
   * Set via: `wrangler secret put EMAIL_API_KEY`
   */
  EMAIL_API_KEY?: string;
  /**
   * Verified sender address for transactional email.
   * Set via: `wrangler secret put EMAIL_FROM`
   */
  EMAIL_FROM: string;
  /**
   * Cloudflare R2 bucket for persistent document storage (tax period uploads).
   * Optional so that local development works without an R2 bucket.
   */
  DOCUMENTS_BUCKET?: R2Bucket;
  /**
   * Cloudflare Browser Rendering binding — powers DGI/BPS portal automation.
   * Requires a paid Cloudflare plan. Optional so local dev still works.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BROWSER?: any;
  /**
   * UruFactura Container — Cloudflare Container (Durable Object) that handles
   * XAdES-BES XML signing and DGI SOAP communication for CFE emission.
   * Deploy from MathiasGonzalez/UruFactura and add the binding in wrangler.jsonc.
   * Optional so local dev and deployments without the container still work.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  URUFACTURA_CONTAINER?: any;
  /**
   * 64-character lowercase hex string (32 bytes) used as the AES-256-GCM key
   * for encrypting DGI/BPS portal session cookies at rest in D1.
   * Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   * Set via: `wrangler secret put PORTAL_ENCRYPTION_KEY`
   */
  PORTAL_ENCRYPTION_KEY?: string;
}

/**
 * Hono context variables set by `requireAuth` middleware.
 * Available in all routes that use `requireAuth` via `c.get(...)`.
 */
type Variables = {
  /** UUID of the authenticated user. */
  userId: string;
  /** UUID of the tenant the user belongs to. */
  tenantId: string;
  /** Verified email address of the authenticated user. */
  email: string;
  /** RBAC role: `'admin'` or `'viewer'`. */
  role: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim() || null;
}

// ---------------------------------------------------------------------------
// Rate limiting middleware – applied to every /api/* request
// ---------------------------------------------------------------------------

app.use("/api/*", async (c, next) => {
  // RATE_LIMITER is not available in local dev; skip when undefined
  if (c.env.RATE_LIMITER) {
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For") ??
      "unknown";

    const { success } = await c.env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return c.json(
        { error: "Demasiadas solicitudes. Intentá nuevamente en un momento." },
        429
      );
    }
  }

  return next();
});

// ---------------------------------------------------------------------------
// Auth middleware – validates session token, populates Variables
// ---------------------------------------------------------------------------

const requireAuth: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> =
  async (c, next) => {
    const token = getSessionToken(c.req.header("Authorization"));
    if (!token) {
      return c.json({ error: "Autenticación requerida." }, 401);
    }

    const authService = new AuthService(c.env);
    const session = await authService.validateSession(token);
    if (!session) {
      return c.json({ error: "Sesión inválida o expirada." }, 401);
    }

    c.set("userId", session.userId);
    c.set("tenantId", session.tenantId);
    c.set("email", session.email);
    c.set("role", session.role);

    return next();
  };

// Requires the authenticated user to have the 'admin' role.
const requireAdmin: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> =
  async (c, next) => {
    if (c.get("role") !== "admin") {
      return c.json({ error: "Se requieren permisos de administrador." }, 403);
    }
    return next();
  };

// ---------------------------------------------------------------------------
// POST /api/auth/request-otp
// Body: { email: string }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/terms/version  – public, returns the active T&C version
// ---------------------------------------------------------------------------

app.get("/api/terms/version", (c) => {
  return c.json({ version: CURRENT_TERMS_VERSION });
});

// ---------------------------------------------------------------------------
// POST /api/auth/request-otp
// Body: { email: string }
// ---------------------------------------------------------------------------

app.post("/api/auth/request-otp", async (c) => {
  const body = await c.req.json<{ email?: string }>();
  const email = body.email?.trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Email inválido." }, 400);
  }

  const authService = new AuthService(c.env);
  const emailService = new EmailService(c.env);

  const code = await authService.requestOtp(email);

  try {
    await emailService.sendOtp(email, code);
  } catch (err) {
    console.error("Email send error:", err);
    return c.json(
      { error: "No se pudo enviar el email. Verificá la dirección e intentá nuevamente." },
      502
    );
  }

  return c.json({ ok: true, message: "Código enviado. Revisá tu bandeja de entrada." });
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-otp
// Body: { email: string; code: string }
// ---------------------------------------------------------------------------

app.post("/api/auth/verify-otp", async (c) => {
  const body = await c.req.json<{ email?: string; code?: string; termsVersion?: string }>();
  const email = body.email?.trim().toLowerCase();
  const code = body.code?.trim();
  const termsVersion = body.termsVersion?.trim();

  if (!email || !code) {
    return c.json({ error: "Email y código son requeridos." }, 400);
  }

  if (termsVersion !== CURRENT_TERMS_VERSION) {
    return c.json(
      { error: "Debés aceptar los Términos y Condiciones vigentes para continuar." },
      400
    );
  }

  const authService = new AuthService(c.env);

  let result: { sessionToken: string; isNewUser: boolean; userId: string };
  try {
    result = await authService.verifyOtp(email, code);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error de verificación.";
    return c.json({ error: message }, 401);
  }

  const ip =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For") ??
    undefined;
  await authService.recordTermsConsent(result.userId, termsVersion, ip);

  return c.json({
    ok: true,
    sessionToken: result.sessionToken,
    isNewUser: result.isNewUser,
    message: result.isNewUser
      ? "Cuenta creada exitosamente."
      : "Sesión iniciada correctamente.",
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

app.post("/api/auth/logout", async (c) => {
  const token = getSessionToken(c.req.header("Authorization"));
  if (token) {
    const authService = new AuthService(c.env);
    await authService.revokeSession(token);
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/feature-flags  (requires auth)
// ---------------------------------------------------------------------------

app.get("/api/feature-flags", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  return c.json({ flags });
});

// ---------------------------------------------------------------------------
// GET /api/me  (requires auth) – returns authenticated user info
// ---------------------------------------------------------------------------

app.get("/api/me", requireAuth, (c) => {
  return c.json({
    userId: c.get("userId"),
    tenantId: c.get("tenantId"),
    email: c.get("email"),
    role: c.get("role"),
  });
});

// ---------------------------------------------------------------------------
// GET /api/documents  (requires auth) – lists corpus documents with chunk counts
// ---------------------------------------------------------------------------

app.get("/api/documents", requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT d.id, d.title, d.source, d.url, d.created_at,
           COUNT(dc.id) AS chunk_count
    FROM documents d
    LEFT JOIN document_chunks dc ON dc.document_id = d.id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all<{
    id: string;
    title: string;
    source: string;
    url: string | null;
    created_at: number;
    chunk_count: number;
  }>();

  return c.json({ documents: rows.results });
});

// ---------------------------------------------------------------------------
// DELETE /api/documents/:id  (requires auth + admin)
// ---------------------------------------------------------------------------

app.delete("/api/documents/:id", requireAuth, requireAdmin, async (c) => {
  const id = c.req.param("id");

  const exists = await c.env.DB.prepare("SELECT id FROM documents WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();

  if (!exists) {
    return c.json({ error: "Documento no encontrado." }, 404);
  }

  const rag = new RagService(c.env);
  await rag.deleteDocument(id);

  return c.json({ ok: true, message: `Documento '${id}' eliminado del corpus.` });
});

// ---------------------------------------------------------------------------
// GET /api/history  (requires auth) – paginated query history for the current user
// ---------------------------------------------------------------------------

app.get("/api/history", requireAuth, async (c) => {
  const userId = c.get("userId");
  const page  = Math.max(1, parseInt(c.req.query("page")  ?? "1",  10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;

  const rows = await c.env.DB.prepare(
    `SELECT id, original_query, sanitized_query, response, latency_ms, created_at
     FROM queries
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(userId, limit + 1, offset).all<{
    id: string;
    original_query: string;
    sanitized_query: string;
    response: string;
    latency_ms: number;
    created_at: number;
  }>();

  const hasMore = rows.results.length > limit;
  const items   = hasMore ? rows.results.slice(0, limit) : rows.results;

  return c.json({
    queries: items.map(r => ({
      id: r.id,
      originalQuery: r.original_query,
      sanitizedQuery: r.sanitized_query,
      response: r.response,
      latencyMs: r.latency_ms,
      createdAt: r.created_at,
    })),
    page,
    limit,
    hasMore,
  });
});

// ---------------------------------------------------------------------------
// GET /api/search  (requires auth)
// ---------------------------------------------------------------------------

app.get("/api/search", requireAuth, async (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "El parámetro q es requerido." }, 400);

  const userId   = c.get("userId");
  const tenantId = c.get("tenantId");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["ai_search_enabled"]) {
    return c.json(
      { error: "La búsqueda con IA está temporalmente deshabilitada." },
      503
    );
  }

  const useHybrid = flags["hybrid_search_enabled"] !== false;

  const startTime   = Date.now();
  const cleanQuery  = Anonymizer.sanitize(query);

  const rag     = new RagService(c.env);
  const context = await rag.searchNormative(cleanQuery, 3, useHybrid);

  const prompt = `
Eres un asistente virtual experto y auditor tributario en Uruguay para DGI y BPS.
Responde la consulta del usuario de forma profesional, clara y estructurada.
Sigue estas reglas fundamentales de forma estricta:
1. Responde de forma exclusiva basándote en el contexto normativo provisto. No alucines leyes.
2. Si no sabes la respuesta o el contexto no la cubre, indícalo de manera honesta.
3. Cita textualmente la ley, decreto, artículo o enlace de la fuente en el texto de tu respuesta.
4. Toda la interacción debe realizarse en español.

Contexto Normativo Recibido:
${context}

Consulta del Usuario:
${cleanQuery}
`;

  const aiResponse = (await c.env.AI.run("@cf/qwen/qwq-32b", {
    messages: [
      {
        role: "system",
        content:
          "Eres una inteligencia artificial grounded que responde basándose únicamente en el contexto provisto.",
      },
      { role: "user", content: prompt },
    ],
  })) as { response?: string };

  const responseText = aiResponse.response ?? "Disculpas, no pudimos procesar la consulta.";
  const latencyMs    = Date.now() - startTime;

  // Persist to query history (non-blocking — failure must not break the response)
  c.executionCtx?.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO queries (id, user_id, tenant_id, original_query, sanitized_query, response, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      userId,
      tenantId,
      query,
      cleanQuery,
      responseText,
      latencyMs,
    ).run().catch((err: unknown) => console.error("History write failed:", err))
  );

  return c.json({
    originalQuery:  query,
    sanitizedQuery: cleanQuery,
    response:       responseText,
    latencyMs,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ingest  (requires auth + admin)
// ---------------------------------------------------------------------------

app.post("/api/ingest", requireAuth, requireAdmin, async (c) => {
  const tenantId = c.get("tenantId");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["document_ingestion_enabled"]) {
    return c.json(
      { error: "La ingestión de documentos está temporalmente deshabilitada." },
      503
    );
  }

  const body = await c.req.json<{
    id?: string;
    title?: string;
    source?: string;
    content?: string;
    url?: string;
  }>();

  const { id, title, source, content, url } = body;
  if (!id || !title || !source || !content) {
    return c.json({ error: "Faltan campos requeridos: id, title, source, content." }, 400);
  }

  // Prevent runaway CPU usage from huge documents processed chunk-by-chunk
  const MAX_CONTENT_CHARS = 20_000;
  if (content.length > MAX_CONTENT_CHARS) {
    return c.json(
      { error: `El contenido excede el límite de ${MAX_CONTENT_CHARS.toLocaleString("es-UY")} caracteres. Dividí el documento en partes más pequeñas.` },
      413
    );
  }

  // Check for duplicate ID before processing
  const existing = await c.env.DB.prepare("SELECT id FROM documents WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (existing) {
    return c.json(
      { error: `Ya existe un documento con id '${id}'. Eliminalo primero o usá un id distinto.` },
      409
    );
  }

  const rag = new RagService(c.env);
  await rag.ingestDocument(id, title, source, content, url ?? "");

  return c.json({
    success: true,
    message: `Documento '${title}' ingestado y contextualizado exitosamente.`,
  });
});

// ---------------------------------------------------------------------------
// Company profile routes
// ---------------------------------------------------------------------------

const VALID_TIPOS_ENTIDAD  = ["srl", "sa", "unipersonal", "cooperativa", "ong", "sas", "otro"] as const;
const VALID_REGIMENES_IRAE = ["real", "forfait", "pequena_empresa", "monotributo", "exonerado", "irnr"] as const;

interface Company {
  id: string;
  rut: string;
  razon_social: string;
  nombre_comercial: string | null;
  tipo_entidad: string;
  regimen_irae: string;
  actividad: string | null;
  bps_nro_patronal: string | null;
  domicilio_fiscal: string | null;
  created_at: number;
}

// GET /api/companies
app.get("/api/companies", requireAuth, async (c) => {
  const userId = c.get("userId");
  const rows = await c.env.DB.prepare(
    `SELECT id, rut, razon_social, nombre_comercial, tipo_entidad, regimen_irae, actividad, bps_nro_patronal, domicilio_fiscal, created_at
     FROM companies WHERE user_id = ? ORDER BY razon_social ASC`
  ).bind(userId).all<Company>();
  return c.json({ companies: rows.results });
});

// POST /api/companies
app.post("/api/companies", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const tenantId = c.get("tenantId");
  const body = await c.req.json<{
    rut?: string; razon_social?: string; nombre_comercial?: string;
    tipo_entidad?: string; regimen_irae?: string; actividad?: string;
    bps_nro_patronal?: string; domicilio_fiscal?: string;
  }>();

  if (!body.rut?.trim() || !body.razon_social?.trim()) {
    return c.json({ error: "RUT y razón social son requeridos." }, 400);
  }

  // Normalize and validate RUT (remove separators, must be 12 digits)
  const rut = body.rut.trim().replace(/[\.\-\s]/g, "");
  if (!/^\d{12}$/.test(rut)) {
    return c.json({ error: "El RUT debe tener 12 dígitos (ej: 210000010018)." }, 400);
  }

  const tipo_entidad = VALID_TIPOS_ENTIDAD.includes(body.tipo_entidad as typeof VALID_TIPOS_ENTIDAD[number])
    ? body.tipo_entidad! : "srl";
  const regimen_irae = VALID_REGIMENES_IRAE.includes(body.regimen_irae as typeof VALID_REGIMENES_IRAE[number])
    ? body.regimen_irae! : "real";

  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO companies (id, user_id, tenant_id, rut, razon_social, nombre_comercial, tipo_entidad, regimen_irae, actividad, bps_nro_patronal, domicilio_fiscal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, userId, tenantId, rut, body.razon_social.trim(),
      body.nombre_comercial?.trim() || null,
      tipo_entidad, regimen_irae,
      body.actividad?.trim() || null,
      body.bps_nro_patronal?.trim() || null,
      body.domicilio_fiscal?.trim() || null
    ).run();
  } catch {
    return c.json({ error: "Ya existe una empresa con ese RUT." }, 409);
  }

  return c.json({
    ok: true,
    company: { id, rut, razon_social: body.razon_social.trim(), nombre_comercial: body.nombre_comercial?.trim() || null, tipo_entidad, regimen_irae },
  }, 201);
});

// PUT /api/companies/:id
app.put("/api/companies/:id", requireAuth, async (c) => {
  const userId = c.get("userId");
  const id     = c.req.param("id");

  const exists = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{ id: string }>();
  if (!exists) return c.json({ error: "Empresa no encontrada." }, 404);

  const body = await c.req.json<{
    razon_social?: string; nombre_comercial?: string; tipo_entidad?: string;
    regimen_irae?: string; actividad?: string; bps_nro_patronal?: string; domicilio_fiscal?: string;
  }>();

  if (!body.razon_social?.trim()) {
    return c.json({ error: "Razón social es requerida." }, 400);
  }

  const tipo_entidad = VALID_TIPOS_ENTIDAD.includes(body.tipo_entidad as typeof VALID_TIPOS_ENTIDAD[number])
    ? body.tipo_entidad! : "srl";
  const regimen_irae = VALID_REGIMENES_IRAE.includes(body.regimen_irae as typeof VALID_REGIMENES_IRAE[number])
    ? body.regimen_irae! : "real";

  await c.env.DB.prepare(`
    UPDATE companies SET
      razon_social     = ?,
      nombre_comercial = ?,
      tipo_entidad     = ?,
      regimen_irae     = ?,
      actividad        = ?,
      bps_nro_patronal = ?,
      domicilio_fiscal = ?,
      updated_at       = strftime('%s', 'now')
    WHERE id = ?
  `).bind(
    body.razon_social.trim(),
    body.nombre_comercial?.trim() || null,
    tipo_entidad, regimen_irae,
    body.actividad?.trim() || null,
    body.bps_nro_patronal?.trim() || null,
    body.domicilio_fiscal?.trim() || null,
    id
  ).run();

  return c.json({ ok: true });
});

// DELETE /api/companies/:id
app.delete("/api/companies/:id", requireAuth, async (c) => {
  const userId = c.get("userId");
  const id     = c.req.param("id");

  const exists = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{ id: string }>();
  if (!exists) return c.json({ error: "Empresa no encontrada." }, 404);

  await c.env.DB.prepare("DELETE FROM companies WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Tax Analysis routes
// ---------------------------------------------------------------------------

const TAX_MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const TAX_MAX_DOCS    = 10;
const TAX_MAX_CHARS   = 8_000;

const TIPO_ENTIDAD_LABELS: Record<string, string> = {
  srl: "Sociedad de Responsabilidad Limitada (SRL)",
  sa: "Sociedad Anónima (SA)",
  unipersonal: "Empresa Unipersonal",
  cooperativa: "Cooperativa",
  ong: "ONG / Asociación Civil",
  sas: "Sociedad por Acciones Simplificada (SAS)",
  otro: "Otro",
};
const REGIMEN_IRAE_LABELS: Record<string, string> = {
  real: "IRAE — Método Real",
  forfait: "IRAE — Forfait",
  pequena_empresa: "Pequeña Empresa (IRAE reducido)",
  monotributo: "Monotributo",
  exonerado: "Exonerado de IRAE",
  irnr: "IRNR (No Residente)",
};

// GET /api/tax/periods  – list authenticated user's tax periods (including company name)
app.get("/api/tax/periods", requireAuth, async (c) => {
  const userId = c.get("userId");
  const rows = await c.env.DB.prepare(`
    SELECT p.id, p.month, p.year, p.label, p.status, p.created_at, p.company_id,
           COUNT(d.id) AS doc_count,
           c.razon_social AS company_name
    FROM tax_periods p
    LEFT JOIN tax_documents d ON d.period_id = p.id
    LEFT JOIN companies c ON c.id = p.company_id
    WHERE p.user_id = ?
    GROUP BY p.id
    ORDER BY p.year DESC, p.month DESC
  `).bind(userId).all<{
    id: string; month: number; year: number; label: string;
    status: string; created_at: number; doc_count: number;
    company_id: string | null; company_name: string | null;
  }>();
  return c.json({ periods: rows.results });
});

// POST /api/tax/periods  – create a new tax period
// Body: { month: number, year: number, company_id?: string, notas?: string }
app.post("/api/tax/periods", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const tenantId = c.get("tenantId");
  const body = await c.req.json<{ month?: number; year?: number; company_id?: string; notas?: string }>();
  const month = Number(body.month);
  const year  = Number(body.year);

  if (!month || !year || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return c.json({ error: "Mes (1-12) y año (>= 2000) son requeridos." }, 400);
  }

  // Validate company_id belongs to this user if provided
  let companyId: string | null = null;
  let companyName: string | null = null;
  if (body.company_id?.trim()) {
    const co = await c.env.DB.prepare(
      "SELECT id, razon_social FROM companies WHERE id = ? AND user_id = ?"
    ).bind(body.company_id.trim(), userId).first<{ id: string; razon_social: string }>();
    if (!co) return c.json({ error: "Empresa no encontrada." }, 404);
    companyId   = co.id;
    companyName = co.razon_social;
  }

  const label = `${TAX_MONTH_NAMES[month - 1]} ${year}`;
  const id    = crypto.randomUUID();

  try {
    await c.env.DB.prepare(
      `INSERT INTO tax_periods (id, user_id, tenant_id, month, year, label, company_id, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, tenantId, month, year, label, companyId, body.notas?.trim() || null).run();
  } catch {
    return c.json({ error: `Ya existe un período para ${label}${companyId ? ` en ${companyName}` : ""}.` }, 409);
  }

  return c.json({
    ok: true,
    period: { id, month, year, label, status: "draft", doc_count: 0, company_id: companyId, company_name: companyName },
  }, 201);
});

// DELETE /api/tax/periods/:id
app.delete("/api/tax/periods/:id", requireAuth, async (c) => {
  const userId = c.get("userId");
  const id     = c.req.param("id");

  const exists = await c.env.DB.prepare(
    "SELECT id FROM tax_periods WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{ id: string }>();
  if (!exists) return c.json({ error: "Período no encontrado." }, 404);

  await c.env.DB.prepare("DELETE FROM tax_periods WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// GET /api/tax/periods/:id/documents
app.get("/api/tax/periods/:id/documents", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const periodId = c.req.param("id");

  const period = await c.env.DB.prepare(`
    SELECT p.id, p.label, p.status, p.company_id, p.notas,
           c.rut AS company_rut, c.razon_social AS company_name,
           c.tipo_entidad, c.regimen_irae, c.actividad, c.bps_nro_patronal
    FROM tax_periods p
    LEFT JOIN companies c ON c.id = p.company_id
    WHERE p.id = ? AND p.user_id = ?
  `).bind(periodId, userId).first<{
    id: string; label: string; status: string;
    company_id: string | null; notas: string | null;
    company_rut: string | null; company_name: string | null;
    tipo_entidad: string | null; regimen_irae: string | null;
    actividad: string | null; bps_nro_patronal: string | null;
  }>();
  if (!period) return c.json({ error: "Período no encontrado." }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT id, filename, doc_type, created_at, LENGTH(content) AS content_length,
            (r2_key IS NOT NULL) AS has_file, source
     FROM tax_documents WHERE period_id = ? ORDER BY created_at ASC`
  ).bind(periodId).all<{
    id: string; filename: string; doc_type: string | null;
    created_at: number; content_length: number;
    has_file: number; source: string | null;
  }>();

  return c.json({ period, documents: rows.results });
});

// POST /api/tax/periods/:id/documents
// Body: { filename: string, content: string, doc_type?: string }
app.post("/api/tax/periods/:id/documents", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const periodId = c.req.param("id");

  const period = await c.env.DB.prepare(
    "SELECT id FROM tax_periods WHERE id = ? AND user_id = ?"
  ).bind(periodId, userId).first<{ id: string }>();
  if (!period) return c.json({ error: "Período no encontrado." }, 404);

  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tax_documents WHERE period_id = ?"
  ).bind(periodId).first<{ n: number }>();
  if ((count?.n ?? 0) >= TAX_MAX_DOCS) {
    return c.json({ error: `Límite de ${TAX_MAX_DOCS} documentos por período alcanzado.` }, 422);
  }

  const body = await c.req.json<{ filename?: string; content?: string; doc_type?: string }>();
  const { filename, content, doc_type } = body;

  if (!filename?.trim() || !content?.trim()) {
    return c.json({ error: "filename y content son requeridos." }, 400);
  }
  if (content.length > TAX_MAX_CHARS) {
    return c.json(
      { error: `El documento excede el límite de ${TAX_MAX_CHARS.toLocaleString("es-UY")} caracteres. Dividilo en partes más pequeñas.` },
      413
    );
  }

  const docId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO tax_documents (id, period_id, user_id, filename, content, doc_type, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(docId, periodId, userId, filename.trim(), content.trim(), doc_type?.trim() || null, "paste").run();

  return c.json({
    ok: true,
    document: { id: docId, filename: filename.trim(), doc_type: doc_type?.trim() || null, content_length: content.length },
  }, 201);
});

// POST /api/tax/periods/:id/upload  – multipart file upload stored in R2
// FormData fields: file (required), doc_type (optional)
app.post("/api/tax/periods/:id/upload", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const periodId = c.req.param("id");

  const period = await c.env.DB.prepare(
    "SELECT id FROM tax_periods WHERE id = ? AND user_id = ?"
  ).bind(periodId, userId).first<{ id: string }>();
  if (!period) return c.json({ error: "Período no encontrado." }, 404);

  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tax_documents WHERE period_id = ?"
  ).bind(periodId).first<{ n: number }>();
  if ((count?.n ?? 0) >= TAX_MAX_DOCS) {
    return c.json({ error: `Límite de ${TAX_MAX_DOCS} documentos por período alcanzado.` }, 422);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Se esperaba un formulario multipart." }, 400);
  }

  const file = formData.get("file") as File | null;
  if (!file || !(file instanceof File)) {
    return c.json({ error: "Se requiere el campo 'file'." }, 400);
  }

  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_FILE_BYTES) {
    return c.json({ error: "El archivo excede el límite de 10 MB." }, 413);
  }

  const doc_type  = (formData.get("doc_type") as string | null)?.trim() || null;
  const filename  = file.name;
  const mimeType  = file.type || "application/octet-stream";
  const fileSize  = file.size;

  // Extract text content for AI analysis (text-based files only)
  const TEXT_MIMES = ["text/", "application/json", "application/csv", "application/xml"];
  const isTextLike = TEXT_MIMES.some(m => mimeType.startsWith(m)) ||
    /\.(txt|csv|json|md|xml|html|htm|log|tsv|toml|yaml|yml)$/i.test(filename);

  let content = "";
  if (isTextLike) {
    content = await file.text();
    if (content.length > TAX_MAX_CHARS) {
      content = content.slice(0, TAX_MAX_CHARS);
    }
  }

  // Store original file in R2 (if bucket is configured)
  let r2Key: string | null = null;
  if (c.env.DOCUMENTS_BUCKET) {
    r2Key = `tax/${userId}/${periodId}/${crypto.randomUUID()}/${filename}`;
    const bytes = await file.arrayBuffer();
    await c.env.DOCUMENTS_BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { userId, periodId },
    });
  }

  const docId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO tax_documents (id, period_id, user_id, filename, content, doc_type, r2_key, mime_type, file_size, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(docId, periodId, userId, filename, content, doc_type, r2Key, mimeType, fileSize, "upload").run();

  return c.json({
    ok: true,
    document: {
      id: docId,
      filename,
      doc_type,
      content_length: content.length,
      mime_type: mimeType,
      file_size: fileSize,
      has_file: r2Key !== null,
      text_extracted: isTextLike,
    },
  }, 201);
});

// POST /api/tax/periods/:id/import-gdoc  – import text from a public Google Docs/Sheets URL
// Body: { url: string, doc_type?: string, filename?: string }
app.post("/api/tax/periods/:id/import-gdoc", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const periodId = c.req.param("id");

  const period = await c.env.DB.prepare(
    "SELECT id FROM tax_periods WHERE id = ? AND user_id = ?"
  ).bind(periodId, userId).first<{ id: string }>();
  if (!period) return c.json({ error: "Período no encontrado." }, 404);

  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tax_documents WHERE period_id = ?"
  ).bind(periodId).first<{ n: number }>();
  if ((count?.n ?? 0) >= TAX_MAX_DOCS) {
    return c.json({ error: `Límite de ${TAX_MAX_DOCS} documentos por período alcanzado.` }, 422);
  }

  const body = await c.req.json<{ url?: string; doc_type?: string; filename?: string }>();
  const rawUrl    = body.url?.trim();
  const doc_type  = body.doc_type?.trim() || null;
  const customFilename = body.filename?.trim() || null;

  if (!rawUrl) return c.json({ error: "La URL es requerida." }, 400);

  // Parse Google Docs or Sheets URL
  const docMatch   = rawUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  const sheetMatch = rawUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);

  let exportUrl: string;
  let defaultFilename: string;

  if (docMatch) {
    exportUrl       = `https://docs.google.com/document/d/${docMatch[1]}/export?format=txt`;
    defaultFilename = customFilename ?? `google-doc-${docMatch[1].slice(0, 8)}.txt`;
  } else if (sheetMatch) {
    exportUrl       = `https://docs.google.com/spreadsheets/d/${sheetMatch[1]}/export?format=csv`;
    defaultFilename = customFilename ?? `google-sheet-${sheetMatch[1].slice(0, 8)}.csv`;
  } else {
    return c.json(
      { error: "URL no válida. Aceptamos enlaces de Google Docs o Google Sheets." },
      400
    );
  }

  let content: string;
  try {
    const res = await fetch(exportUrl, { redirect: "follow" });
    if (!res.ok) {
      return c.json(
        { error: "No se pudo acceder al documento. Verificá que esté compartido como 'Cualquier persona con el enlace puede ver'." },
        422
      );
    }
    content = await res.text();
  } catch {
    return c.json({ error: "Error al conectar con Google. Intentá nuevamente." }, 502);
  }

  if (!content.trim()) {
    return c.json({ error: "El documento está vacío o no se pudo leer su contenido." }, 422);
  }
  if (content.length > TAX_MAX_CHARS) {
    content = content.slice(0, TAX_MAX_CHARS);
  }

  const docId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO tax_documents (id, period_id, user_id, filename, content, doc_type, source, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(docId, periodId, userId, defaultFilename, content, doc_type, "gdoc", rawUrl).run();

  return c.json({
    ok: true,
    document: {
      id: docId,
      filename: defaultFilename,
      doc_type,
      content_length: content.length,
    },
  }, 201);
});

// DELETE /api/tax/periods/:id/documents/:docId
app.delete("/api/tax/periods/:id/documents/:docId", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const periodId = c.req.param("id");
  const docId    = c.req.param("docId");

  const period = await c.env.DB.prepare(
    "SELECT id FROM tax_periods WHERE id = ? AND user_id = ?"
  ).bind(periodId, userId).first<{ id: string }>();
  if (!period) return c.json({ error: "Período no encontrado." }, 404);

  // Fetch R2 key before deletion so we can clean up the stored file
  const doc = await c.env.DB.prepare(
    "SELECT r2_key FROM tax_documents WHERE id = ? AND period_id = ?"
  ).bind(docId, periodId).first<{ r2_key: string | null }>();

  await c.env.DB.prepare(
    "DELETE FROM tax_documents WHERE id = ? AND period_id = ?"
  ).bind(docId, periodId).run();

  // Clean up R2 object (non-blocking — failure must not break the response)
  if (doc?.r2_key && c.env.DOCUMENTS_BUCKET) {
    c.executionCtx?.waitUntil(
      c.env.DOCUMENTS_BUCKET.delete(doc.r2_key).catch((err: unknown) =>
        console.error("R2 delete failed:", err)
      )
    );
  }

  return c.json({ ok: true });
});

// GET /api/tax/periods/:id/documents/:docId/download  – serve original file from R2
app.get("/api/tax/periods/:id/documents/:docId/download", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const periodId = c.req.param("id");
  const docId    = c.req.param("docId");

  const doc = await c.env.DB.prepare(`
    SELECT d.filename, d.mime_type, d.r2_key
    FROM tax_documents d
    JOIN tax_periods p ON p.id = d.period_id
    WHERE d.id = ? AND d.period_id = ? AND p.user_id = ?
  `).bind(docId, periodId, userId).first<{
    filename: string;
    mime_type: string | null;
    r2_key: string | null;
  }>();

  if (!doc) return c.json({ error: "Documento no encontrado." }, 404);
  if (!doc.r2_key || !c.env.DOCUMENTS_BUCKET) {
    return c.json({ error: "Este documento no tiene archivo almacenado." }, 404);
  }

  const object = await c.env.DOCUMENTS_BUCKET.get(doc.r2_key);
  if (!object) return c.json({ error: "Archivo no encontrado en almacenamiento." }, 404);

  const safeFilename = encodeURIComponent(doc.filename).replace(/%20/g, " ");
  return new Response(object.body, {
    headers: {
      "Content-Type":        doc.mime_type ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control":       "private, no-cache",
    },
  });
});

// POST /api/tax/periods/:id/consolidate  – run AI tax consolidation
app.post("/api/tax/periods/:id/consolidate", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const tenantId = c.get("tenantId");
  const periodId = c.req.param("id");

  const period = await c.env.DB.prepare(`
    SELECT p.id, p.label, p.notas,
           c.rut AS company_rut, c.razon_social AS company_name,
           c.tipo_entidad, c.regimen_irae, c.actividad, c.bps_nro_patronal
    FROM tax_periods p
    LEFT JOIN companies c ON c.id = p.company_id
    WHERE p.id = ? AND p.user_id = ?
  `).bind(periodId, userId).first<{
    id: string; label: string; notas: string | null;
    company_rut: string | null; company_name: string | null;
    tipo_entidad: string | null; regimen_irae: string | null;
    actividad: string | null; bps_nro_patronal: string | null;
  }>();
  if (!period) return c.json({ error: "Período no encontrado." }, 404);

  const ffService = new FeatureFlagsService(c.env);
  const flags     = await ffService.getFlags(tenantId);
  if (!flags["ai_search_enabled"]) {
    return c.json({ error: "El análisis con IA está temporalmente deshabilitado." }, 503);
  }

  const docs = await c.env.DB.prepare(
    `SELECT filename, content, doc_type FROM tax_documents WHERE period_id = ? ORDER BY created_at ASC`
  ).bind(periodId).all<{ filename: string; content: string; doc_type: string | null }>();

  if (docs.results.length === 0) {
    return c.json({ error: "No hay documentos en este período. Subí al menos uno antes de consolidar." }, 422);
  }

  const docsContext = docs.results
    .map((d, i) => `--- Documento ${i + 1}: ${d.filename}${d.doc_type ? ` (${d.doc_type})` : ""} ---\n${d.content}`)
    .join("\n\n");

  // Build company context if linked
  const companyLines: string[] = [];
  if (period.company_name) {
    companyLines.push(`EMPRESA ANALIZADA:`);
    companyLines.push(`  Razón social: ${period.company_name}${period.company_rut ? ` — RUT: ${period.company_rut}` : ""}`);
    if (period.tipo_entidad) companyLines.push(`  Tipo de entidad: ${TIPO_ENTIDAD_LABELS[period.tipo_entidad] ?? period.tipo_entidad}`);
    if (period.regimen_irae) companyLines.push(`  Régimen tributario: ${REGIMEN_IRAE_LABELS[period.regimen_irae] ?? period.regimen_irae}`);
    if (period.actividad)    companyLines.push(`  Actividad económica: ${period.actividad}`);
    if (period.bps_nro_patronal) companyLines.push(`  N° Patronal BPS: ${period.bps_nro_patronal}`);
  }
  if (period.notas) companyLines.push(`\nNOTAS DEL PERÍODO: ${period.notas}`);
  const companyContext = companyLines.length > 0 ? `\n\n${companyLines.join("\n")}` : "";

  const prompt = `Sos un contador público matriculado especializado en tributación uruguaya (DGI/BPS). Analizá los documentos del período ${period.label} y producí un análisis tributario completo y profesional.${companyContext}

NORMATIVA VIGENTE URUGUAY (2024-2025):

1. IVA (Impuesto al Valor Agregado):
   - Tasa básica: 22% | Tasa mínima: 10% (alimentos básicos, medicamentos, construcción)
   - Declaración mensual: vence entre el 20° y 25° día del mes siguiente (varía por dígito del RUT)
   - IVA neto = IVA ventas − IVA compras; si es negativo → crédito fiscal a compensar o devolver
   - Contribuyentes CEDE (grandes contribuyentes): plazos anticipados

2. IRAE (Impuesto a la Renta de Actividades Empresariales):
   - Tasa general: 25% sobre renta neta fiscal del ejercicio
   - Anticipo mensual: ~1/12 del impuesto estimado del año; vence ~20-25 del mes siguiente
   - Régimen forfait: tasa efectiva reducida para pequeñas empresas (facturación ≤ UI 4.000.000)
   - Pequeña empresa: puede optar por pagar el 25% del impuesto determinado con tasas menores
   - Declaración jurada anual: Formulario 1101 (vence en abril-mayo del año siguiente)
   - Mínimo no imponible: UI 30.000 anuales

3. IRPF (Impuesto a la Renta de las Personas Físicas):
   - Categoría 1 (rendimientos de capital):
     * Rentas de capital inmobiliario: 10.5%
     * Otros rendimientos de capital: 12%
   - Categoría 2 (rentas del trabajo — escala progresiva 2025):
     * 0-7 BPC/mes → 0% | 7-10 BPC → 10% | 10-25 BPC → 15%
     * 25-50 BPC → 20% | 50-100 BPC → 25% | 100-180 BPC → 30% | >180 BPC → 36%
   - BPC 2025 ≈ $ 6.769 (Base de Prestaciones y Contribuciones)
   - Retenciones mensuales por empleadores: Formulario 2181; vence ~20-25 del mes siguiente
   - Declaración anual empleados en relación de dependencia: Formulario 1102; vence 30/06

4. IRNR (Impuesto a la Renta de los No Residentes):
   - Tasa general: 12% sobre rentas de fuente uruguaya
   - Retención por el pagador local al efectuar el pago
   - Paraísos fiscales: tasa del 25%

5. IP (Impuesto al Patrimonio):
   - Empresas y personas jurídicas: 1.5% anual sobre patrimonio fiscal neto
   - Personas físicas: MNI ~UI 4.774.000; tasas entre 0.1% y 0.7% sobre excedente
   - Anticipo en el ejercicio; declaración y pago final con balance anual

6. BPS / Seguridad Social:
   Aportes patronales (a cargo del empleador) sobre salario nominal:
   - Jubilaciones: 7.5% | FONASA (empleador): 5% | Fondo Reconversión Laboral: 0.1%
   - Total patronal base ≈ 12.625% (más FGT, aporte de solidaridad según planilla)
   Aportes personales (a cargo del trabajador):
   - Jubilaciones: 15% | FONASA (trabajador): 3% a 6% (escala por salario) | IRPF Cat 2
   - Nómina BPS (sistema SUNA): vence el 10° día del mes siguiente al devengado

7. MONOTRIBUTO (régimen simplificado):
   - Cuota única mensual (BPS + DGI) — categorías según ingresos anuales:
     * Cat A: facturación ≤ UI 305.000 | Cat B: ≤ UI 610.000 | Cat C: ≤ UI 915.000
   - Vencimiento: día 10 del mes siguiente
   - Incluye jubilaciones + FONASA + contribución especial + IVA ficto + IRPF

8. OTROS TRIBUTOS FRECUENTES:
   - IMEBA (actividades agropecuarias): tasa variable según producto
   - Contribución Inmobiliaria: anual, municipio correspondiente
   - Patente de rodados: anual, municipio
   - ITP (Impuesto a las Transmisiones Patrimoniales): 2% comprador + 2% vendedor en inmuebles

CALENDARIOS APROXIMADOS DE VENCIMIENTO (mes M, declarado en M+1):
- IVA + IRAE anticipo + IRPF retenciones: días 20-25 de M+1 (según último dígito RUT)
- BPS nómina: día 10 de M+1
- Monotributo: día 10 de M+1
- IRAE anual (Form 1101): abril-mayo del año siguiente
- IRPF anual (Form 1102): 30 de junio del año siguiente

FORMULARIOS DGI DE REFERENCIA:
- Formulario 1101: IRAE anual | Formulario 1102: IRPF anual
- Formulario 2181: Retenciones IRPF Cat 2 (empleadores)
- Formulario F.F.: IVA mensual + anticipos IRAE (flujo financiero)

Con base en toda esta normativa y los documentos provistos, generá el análisis tributario completo.

Para cada impuesto identificado indicá:
- tipo: nombre exacto del impuesto (incluyendo el formulario DGI si aplica)
- base_imponible: monto base imponible en pesos uruguayos (número, o null)
- tasa: tasa porcentual aplicable (número, o null)
- monto_estimado: monto estimado a pagar/retener en pesos (número, o null)
- vencimiento: fecha estimada de vencimiento (texto "DD/MM/AAAA"), o null
- estado: "a_pagar" | "retencion" | "a_cobrar" | "informativo"
- notas: observaciones relevantes (puede ser null)

Respondé ÚNICAMENTE con un objeto JSON válido con esta estructura (sin markdown, sin texto extra):
{
  "periodo": "${period.label}",
  "resumen": "descripción profesional de la situación impositiva global del período",
  "impuestos": [ { "tipo": "...", "base_imponible": ..., "tasa": ..., "monto_estimado": ..., "vencimiento": "...", "estado": "...", "notas": "..." } ],
  "alertas": ["lista de alertas, riesgos o advertencias tributarias relevantes"],
  "recomendaciones": ["acciones concretas recomendadas al contribuyente"],
  "total_a_pagar": monto_total_numero_o_null
}

Si no podés determinar un valor con certeza, usá null. Basate SOLO en los documentos provistos y la normativa uruguaya.

${docsContext}`;

  const aiResponse = (await c.env.AI.run("@cf/qwen/qwq-32b", {
    messages: [
      {
        role: "system",
        content: "Sos un contador público matriculado en Uruguay especializado en DGI y BPS. Respondé SOLO con JSON válido sin ningún texto adicional ni bloques de código markdown. No incluyas explicaciones antes ni después del JSON.",
      },
      { role: "user", content: prompt },
    ],
  })) as { response?: string };

  const rawResponse = aiResponse.response ?? "";

  const consolidationId = crypto.randomUUID();
  await c.env.DB.prepare("DELETE FROM tax_consolidations WHERE period_id = ?").bind(periodId).run();
  await c.env.DB.prepare(
    `INSERT INTO tax_consolidations (id, period_id, raw_response) VALUES (?, ?, ?)`
  ).bind(consolidationId, periodId, rawResponse).run();

  await c.env.DB.prepare("UPDATE tax_periods SET status = 'analyzed' WHERE id = ?").bind(periodId).run();

  return c.json({ ok: true, response: rawResponse });
});

// GET /api/tax/periods/:id/consolidation  – fetch existing consolidation result
app.get("/api/tax/periods/:id/consolidation", requireAuth, async (c) => {
  const userId   = c.get("userId");
  const periodId = c.req.param("id");

  const period = await c.env.DB.prepare(
    "SELECT id, label, status FROM tax_periods WHERE id = ? AND user_id = ?"
  ).bind(periodId, userId).first<{ id: string; label: string; status: string }>();
  if (!period) return c.json({ error: "Período no encontrado." }, 404);

  if (period.status !== "analyzed") return c.json({ analyzed: false });

  const result = await c.env.DB.prepare(
    "SELECT raw_response, created_at FROM tax_consolidations WHERE period_id = ?"
  ).bind(periodId).first<{ raw_response: string; created_at: number }>();

  if (!result) return c.json({ analyzed: false });

  return c.json({ analyzed: true, raw_response: result.raw_response, created_at: result.created_at });
});

// ---------------------------------------------------------------------------
// Portal automation routes — DGI SIGA and BPS SUNA
// Gated behind the `portal_automation_enabled` feature flag.
// All routes expect the request body / query to include a `company_id` that
// belongs to the authenticated user.
// ---------------------------------------------------------------------------

const VALID_PORTALS: Portal[] = ["dgi", "bps"];
const VALID_TASKS: PortalTask[] = [
  "consulta_estado_cuenta",
  "descarga_constancia",
  "consulta_deuda",
];

function isValidPortal(v: unknown): v is Portal {
  return typeof v === "string" && (VALID_PORTALS as string[]).includes(v);
}

function isValidTask(v: unknown): v is PortalTask {
  return typeof v === "string" && (VALID_TASKS as string[]).includes(v);
}

// Helper: resolve the encrypted cookies for a (company, portal) pair.
async function getPortalSession(
  db: D1Database,
  userId: string,
  companyId: string,
  portal: Portal
): Promise<{ id: string; ciphertext: string; iv: string } | null> {
  return db
    .prepare(
      `SELECT id, encrypted_cookies AS ciphertext, cookies_iv AS iv
       FROM portal_sessions
       WHERE company_id = ? AND user_id = ? AND portal = ?`
    )
    .bind(companyId, userId, portal)
    .first<{ id: string; ciphertext: string; iv: string }>();
}

// POST /api/portal/:portal/connect
// Body: { company_id: string, username: string, password: string }
// Logs in to the portal, encrypts the resulting session cookies, and stores
// them in `portal_sessions` (upsert). Returns { ok: true } on success.
app.post("/api/portal/:portal/connect", requireAuth, async (c) => {
  const portal = c.req.param("portal");
  if (!isValidPortal(portal)) {
    return c.json({ error: "Portal no válido. Usá 'dgi' o 'bps'." }, 400);
  }

  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");

  const ffService = new FeatureFlagsService(c.env);
  const flags     = await ffService.getFlags(tenantId);
  if (!flags["portal_automation_enabled"]) {
    return c.json({ error: "La automatización de portales no está habilitada." }, 503);
  }

  if (!c.env.BROWSER) {
    return c.json(
      { error: "Browser Rendering no está configurado en este entorno." },
      503
    );
  }
  if (!c.env.PORTAL_ENCRYPTION_KEY) {
    return c.json(
      { error: "La clave de cifrado de portales no está configurada." },
      503
    );
  }

  const body = await c.req.json<{
    company_id?: string;
    username?: string;
    password?: string;
  }>();

  if (!body.company_id?.trim() || !body.username?.trim() || !body.password?.trim()) {
    return c.json({ error: "company_id, username y password son requeridos." }, 400);
  }

  // Verify the company belongs to the authenticated user
  const company = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?"
  )
    .bind(body.company_id.trim(), userId)
    .first<{ id: string }>();
  if (!company) {
    return c.json({ error: "Empresa no encontrada." }, 404);
  }

  const browserService = new PortalBrowserService(c.env.BROWSER);
  const result = await browserService.login(portal, body.username.trim(), body.password.trim());

  if (!result.success || !result.cookies) {
    return c.json({ error: result.error ?? "No se pudo iniciar sesión en el portal." }, 422);
  }

  // Encrypt cookies before persisting
  const cookiesJson = JSON.stringify(result.cookies);
  const { ciphertext, iv } = await encryptData(cookiesJson, c.env.PORTAL_ENCRYPTION_KEY);

  const now = Math.floor(Date.now() / 1000);
  const id  = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO portal_sessions
       (id, company_id, user_id, portal, encrypted_cookies, cookies_iv, session_established_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, portal) DO UPDATE SET
       encrypted_cookies      = excluded.encrypted_cookies,
       cookies_iv             = excluded.cookies_iv,
       session_established_at = excluded.session_established_at,
       updated_at             = strftime('%s', 'now')`
  )
    .bind(id, body.company_id.trim(), userId, portal, ciphertext, iv, now)
    .run();

  return c.json({
    ok: true,
    message: `Sesión ${portal.toUpperCase()} establecida correctamente.`,
  });
});

// GET /api/portal/:portal/status?company_id=xxx
// Returns whether a stored session exists for the given company + portal.
app.get("/api/portal/:portal/status", requireAuth, async (c) => {
  const portal = c.req.param("portal");
  if (!isValidPortal(portal)) {
    return c.json({ error: "Portal no válido. Usá 'dgi' o 'bps'." }, 400);
  }

  const userId    = c.get("userId");
  const companyId = c.req.query("company_id");
  if (!companyId?.trim()) {
    return c.json({ error: "El parámetro company_id es requerido." }, 400);
  }

  const session = await getPortalSession(c.env.DB, userId, companyId.trim(), portal);

  return c.json({ connected: session !== null });
});

// POST /api/portal/:portal/task
// Body: { company_id: string, task: PortalTask, params?: Record<string, string> }
// Restores the stored session and executes the requested task.
// If the session has expired, returns { expired: true } so the client can
// prompt the user to reconnect.
app.post("/api/portal/:portal/task", requireAuth, async (c) => {
  const portal = c.req.param("portal");
  if (!isValidPortal(portal)) {
    return c.json({ error: "Portal no válido. Usá 'dgi' o 'bps'." }, 400);
  }

  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");

  const ffService = new FeatureFlagsService(c.env);
  const flags     = await ffService.getFlags(tenantId);
  if (!flags["portal_automation_enabled"]) {
    return c.json({ error: "La automatización de portales no está habilitada." }, 503);
  }

  if (!c.env.BROWSER) {
    return c.json(
      { error: "Browser Rendering no está configurado en este entorno." },
      503
    );
  }
  if (!c.env.PORTAL_ENCRYPTION_KEY) {
    return c.json(
      { error: "La clave de cifrado de portales no está configurada." },
      503
    );
  }

  const body = await c.req.json<{
    company_id?: string;
    task?: string;
    params?: Record<string, string>;
  }>();

  if (!body.company_id?.trim()) {
    return c.json({ error: "company_id es requerido." }, 400);
  }
  if (!isValidTask(body.task)) {
    return c.json(
      { error: `Tarea no válida. Opciones: ${VALID_TASKS.join(", ")}.` },
      400
    );
  }

  // Load the stored encrypted session
  const session = await getPortalSession(
    c.env.DB,
    userId,
    body.company_id.trim(),
    portal
  );
  if (!session) {
    return c.json(
      { error: "No hay sesión activa para este portal. Conectá el portal primero." },
      422
    );
  }

  // Decrypt cookies
  let cookies: PortalCookie[];
  try {
    const plain = await decryptData(
      { ciphertext: session.ciphertext, iv: session.iv },
      c.env.PORTAL_ENCRYPTION_KEY
    );
    cookies = JSON.parse(plain) as PortalCookie[];
  } catch {
    return c.json(
      { error: "No se pudieron descifrar las cookies almacenadas. Reconectá el portal." },
      500
    );
  }

  const browserService = new PortalBrowserService(c.env.BROWSER);
  const result = await browserService.runTask(portal, cookies, body.task, body.params);

  // If the session expired, signal the client clearly
  if (!result.success && result.error?.includes("expiró")) {
    return c.json({ expired: true, error: result.error }, 401);
  }

  if (!result.success) {
    return c.json({ error: result.error ?? "Error al ejecutar la tarea." }, 502);
  }

  // Record last_used_at (non-blocking)
  c.executionCtx?.waitUntil(
    c.env.DB.prepare(
      "UPDATE portal_sessions SET last_used_at = strftime('%s', 'now'), updated_at = strftime('%s', 'now') WHERE id = ?"
    )
      .bind(session.id)
      .run()
      .catch((err: unknown) => console.error("portal_sessions update failed:", err))
  );

  return c.json({ ok: true, task: body.task, data: result.data });
});

// DELETE /api/portal/:portal/disconnect
// Body: { company_id: string }
// Clears the stored session for the given company + portal.
app.delete("/api/portal/:portal/disconnect", requireAuth, async (c) => {
  const portal = c.req.param("portal");
  if (!isValidPortal(portal)) {
    return c.json({ error: "Portal no válido. Usá 'dgi' o 'bps'." }, 400);
  }

  const userId = c.get("userId");
  const body   = await c.req.json<{ company_id?: string }>();

  if (!body.company_id?.trim()) {
    return c.json({ error: "company_id es requerido." }, 400);
  }

  await c.env.DB.prepare(
    "DELETE FROM portal_sessions WHERE company_id = ? AND user_id = ? AND portal = ?"
  )
    .bind(body.company_id.trim(), userId, portal)
    .run();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CFE / e-Factura routes
// Gated behind the `cfe_enabled` feature flag.
// All routes expect `company_id` to belong to the authenticated user.
// Actual XML signing and DGI communication is proxied to the UruFactura
// Container (MathiasGonzalez/UruFactura). If the container is not configured,
// POST /api/cfe/emit degrades gracefully and saves the CFE as a draft (202);
// routes that require the container for operations other than emission return 503.
// ---------------------------------------------------------------------------

const VALID_TIPOS_CFE = [101, 111, 112, 121, 151, 181, 102] as const;
type TipoCfe = typeof VALID_TIPOS_CFE[number];

const TIPOS_CFE_LABELS: Record<number, string> = {
  101: "e-Ticket",
  111: "e-Factura",
  112: "Nota Crédito e-Ticket",
  121: "e-Factura Exportación",
  151: "e-Resguardo",
  181: "e-Remito",
  102: "Nota Crédito e-Factura",
};

const VALID_IVA_TASAS = ["22", "10", "0", "exento"] as const;
type IvaTasa = typeof VALID_IVA_TASAS[number];

const VALID_AMBIENTES = ["homologacion", "produccion"] as const;

function isValidTipoCfe(v: unknown): v is TipoCfe {
  return typeof v === "number" && (VALID_TIPOS_CFE as readonly number[]).includes(v);
}

/** Validate 12-digit Uruguay RUT (accepts separators). Returns normalized string or null. */
function normalizeRut(raw: string): string | null {
  const rut = raw.trim().replace(/[\.\-\s]/g, "");
  return /^\d{12}$/.test(rut) ? rut : null;
}

/**
 * Estimate IVA amount from subtotal and tasa.
 * Uruguay: IVA is on top of subtotal (subtotal is ex-IVA).
 */
function calcIva(subtotal: number, tasa: IvaTasa): number {
  if (tasa === "exento" || tasa === "0") return 0;
  return Math.round(subtotal * (parseInt(tasa) / 100) * 100) / 100;
}

// GET /api/cfe/config?company_id=  — retrieve CFE config for a company
app.get("/api/cfe/config", requireAuth, async (c) => {
  const tenantId  = c.get("tenantId");
  const userId    = c.get("userId");
  const companyId = c.req.query("company_id")?.trim();

  if (!companyId) return c.json({ error: "El parámetro company_id es requerido." }, 400);

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const company = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?"
  ).bind(companyId, userId).first<{ id: string }>();
  if (!company) return c.json({ error: "Empresa no encontrada." }, 404);

  const config = await c.env.DB.prepare(
    `SELECT id, ambiente, serie, serie_inicio, created_at, updated_at
     FROM cfe_configs WHERE company_id = ? AND user_id = ?`
  ).bind(companyId, userId).first<{
    id: string; ambiente: string; serie: string;
    serie_inicio: number; created_at: number; updated_at: number;
  }>();

  return c.json({ config: config ?? null });
});

// POST /api/cfe/config  — upsert CFE config for a company
// Body: { company_id, ambiente?, serie?, serie_inicio? }
app.post("/api/cfe/config", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const body = await c.req.json<{
    company_id?: string;
    ambiente?: string;
    serie?: string;
    serie_inicio?: number;
  }>();

  if (!body.company_id?.trim()) {
    return c.json({ error: "company_id es requerido." }, 400);
  }

  const company = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?"
  ).bind(body.company_id.trim(), userId).first<{ id: string }>();
  if (!company) return c.json({ error: "Empresa no encontrada." }, 404);

  const ambiente = VALID_AMBIENTES.includes(body.ambiente as typeof VALID_AMBIENTES[number])
    ? body.ambiente! : "homologacion";
  const serie = body.serie?.trim().toUpperCase() || "A";
  const serieInicio = Math.max(1, Math.floor(Number(body.serie_inicio) || 1));

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO cfe_configs (id, user_id, tenant_id, company_id, ambiente, serie, serie_inicio)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id) DO UPDATE SET
       ambiente     = excluded.ambiente,
       serie        = excluded.serie,
       serie_inicio = excluded.serie_inicio,
       updated_at   = strftime('%s', 'now')`
  ).bind(id, userId, tenantId, body.company_id.trim(), ambiente, serie, serieInicio).run();

  return c.json({ ok: true, config: { ambiente, serie, serie_inicio: serieInicio } });
});

// POST /api/cfe/caes  — register CAE ranges received from DGI
// Body: { company_id, tipo_cfe, serie, rango_desde, rango_hasta, fecha_vencimiento? }
app.post("/api/cfe/caes", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const body = await c.req.json<{
    company_id?: string;
    tipo_cfe?: number;
    serie?: string;
    rango_desde?: number;
    rango_hasta?: number;
    fecha_vencimiento?: string;
  }>();

  if (!body.company_id?.trim()) return c.json({ error: "company_id es requerido." }, 400);
  if (!isValidTipoCfe(body.tipo_cfe)) {
    return c.json({ error: `tipo_cfe inválido. Valores válidos: ${VALID_TIPOS_CFE.join(", ")}.` }, 400);
  }
  if (!body.serie?.trim()) return c.json({ error: "serie es requerida." }, 400);
  if (!Number.isInteger(body.rango_desde) || !Number.isInteger(body.rango_hasta) ||
      body.rango_desde! < 1 || body.rango_hasta! < body.rango_desde!) {
    return c.json({ error: "rango_desde y rango_hasta deben ser enteros positivos (desde ≤ hasta)." }, 400);
  }

  const company = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?"
  ).bind(body.company_id.trim(), userId).first<{ id: string }>();
  if (!company) return c.json({ error: "Empresa no encontrada." }, 404);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO cfe_caes (id, company_id, tipo_cfe, serie, rango_desde, rango_hasta, fecha_vencimiento)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, tipo_cfe, serie) DO UPDATE SET
       rango_desde       = excluded.rango_desde,
       rango_hasta       = excluded.rango_hasta,
       ultimo_nro_usado  = 0,
       fecha_vencimiento = excluded.fecha_vencimiento`
  ).bind(
    id, body.company_id.trim(), body.tipo_cfe!, body.serie.trim(),
    body.rango_desde!, body.rango_hasta!,
    body.fecha_vencimiento?.trim() || null
  ).run();

  return c.json({ ok: true });
});

// GET /api/cfe/caes  — list CAE ranges for a company
// Query: company_id (required)
app.get("/api/cfe/caes", requireAuth, async (c) => {
  const tenantId  = c.get("tenantId");
  const userId    = c.get("userId");
  const companyId = c.req.query("company_id")?.trim();

  if (!companyId) return c.json({ error: "El parámetro company_id es requerido." }, 400);

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const company = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?"
  ).bind(companyId, userId).first<{ id: string }>();
  if (!company) return c.json({ error: "Empresa no encontrada." }, 404);

  const caes = await c.env.DB.prepare(
    `SELECT id, tipo_cfe, serie, rango_desde, rango_hasta, ultimo_nro_usado, fecha_vencimiento
     FROM cfe_caes WHERE company_id = ?
     ORDER BY tipo_cfe ASC, serie ASC`
  ).bind(company.id).all<{
    id: string; tipo_cfe: number; serie: string; rango_desde: number; rango_hasta: number;
    ultimo_nro_usado: number; fecha_vencimiento: string | null;
  }>();

  return c.json({ caes: caes.results });
});

// GET /api/cfe/documents  — list CFEs for the authenticated user
// Query: company_id (required), tipo_cfe?, estado?, page?, limit?
app.get("/api/cfe/documents", requireAuth, async (c) => {
  const tenantId  = c.get("tenantId");
  const userId    = c.get("userId");
  const companyId = c.req.query("company_id")?.trim();

  if (!companyId) return c.json({ error: "El parámetro company_id es requerido." }, 400);

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const company = await c.env.DB.prepare(
    "SELECT id FROM companies WHERE id = ? AND user_id = ?"
  ).bind(companyId, userId).first<{ id: string }>();
  if (!company) return c.json({ error: "Empresa no encontrada." }, 404);

  const tipoCfeRaw = parseInt(c.req.query("tipo_cfe") ?? "0");
  const estado     = c.req.query("estado")?.trim() || null;
  const page       = Math.max(1, parseInt(c.req.query("page")  ?? "1",  10));
  const limit      = Math.min(50, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10)));
  const offset     = (page - 1) * limit;

  const conditions: string[] = ["company_id = ?", "user_id = ?"];
  const params: (string | number)[] = [companyId, userId];

  if (isValidTipoCfe(tipoCfeRaw)) {
    conditions.push("tipo_cfe = ?");
    params.push(tipoCfeRaw);
  }
  if (estado) {
    conditions.push("estado = ?");
    params.push(estado);
  }

  const where = conditions.join(" AND ");
  const rows = await c.env.DB.prepare(
    `SELECT id, tipo_cfe, numero, serie, fecha_emision, rut_receptor, razon_receptor,
            concepto, subtotal, iva_tasa, monto_iva, total, estado, cae_numero, cfe_xml_r2_key, created_at
     FROM cfe_documents
     WHERE ${where}
     ORDER BY fecha_emision DESC, created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit + 1, offset).all<{
    id: string; tipo_cfe: number; numero: number | null; serie: string | null;
    fecha_emision: string; rut_receptor: string | null; razon_receptor: string | null;
    concepto: string; subtotal: number; iva_tasa: string; monto_iva: number; total: number;
    estado: string; cae_numero: string | null; cfe_xml_r2_key: string | null; created_at: number;
  }>();

  const hasMore  = rows.results.length > limit;
  const rawItems = hasMore ? rows.results.slice(0, limit) : rows.results;
  const items    = rawItems.map(({ cfe_xml_r2_key, ...rest }) => ({ ...rest, has_xml: cfe_xml_r2_key !== null }));

  return c.json({ documents: items, page, limit, hasMore });
});

// GET /api/cfe/documents/:id  — get a single CFE
app.get("/api/cfe/documents/:id", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");
  const id       = c.req.param("id");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const doc = await c.env.DB.prepare(
    `SELECT id, tipo_cfe, numero, serie, fecha_emision, rut_receptor, razon_receptor,
            concepto, subtotal, iva_tasa, monto_iva, total, estado,
            cfe_xml_r2_key, cae_numero, periodo_id, created_at, updated_at
     FROM cfe_documents WHERE id = ? AND user_id = ?`
  ).bind(id, userId).first<{
    id: string; tipo_cfe: number; numero: number | null; serie: string | null;
    fecha_emision: string; rut_receptor: string | null; razon_receptor: string | null;
    concepto: string; subtotal: number; iva_tasa: string; monto_iva: number; total: number;
    estado: string; cfe_xml_r2_key: string | null; cae_numero: string | null;
    periodo_id: string | null; created_at: number; updated_at: number;
  }>();

  if (!doc) return c.json({ error: "CFE no encontrado." }, 404);

  return c.json({ document: { ...doc, has_xml: doc.cfe_xml_r2_key !== null } });
});

// GET /api/cfe/documents/:id/xml  — download the signed XML from R2
app.get("/api/cfe/documents/:id/xml", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");
  const id       = c.req.param("id");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const doc = await c.env.DB.prepare(
    "SELECT tipo_cfe, numero, serie, cfe_xml_r2_key FROM cfe_documents WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{
    tipo_cfe: number; numero: number | null; serie: string | null; cfe_xml_r2_key: string | null;
  }>();

  if (!doc) return c.json({ error: "CFE no encontrado." }, 404);
  if (!doc.cfe_xml_r2_key || !c.env.DOCUMENTS_BUCKET) {
    return c.json({ error: "Este CFE no tiene XML almacenado." }, 404);
  }

  const object = await c.env.DOCUMENTS_BUCKET.get(doc.cfe_xml_r2_key);
  if (!object) return c.json({ error: "Archivo XML no encontrado en almacenamiento." }, 404);

  const filename = `CFE_${TIPOS_CFE_LABELS[doc.tipo_cfe] ?? doc.tipo_cfe}_${doc.serie ?? ""}${doc.numero ?? id}.xml`;
  const asciiFilename = filename.replace(/[^\x20-\x7E]/g, "_");
  return new Response(object.body, {
    headers: {
      "Content-Type":        "application/xml",
      "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control":       "private, no-cache",
    },
  });
});

// POST /api/cfe/emit  — validate and emit a new CFE
// Body: { company_id, tipo_cfe, rut_receptor, razon_receptor, concepto,
//         subtotal, iva_tasa, fecha_emision? }
app.post("/api/cfe/emit", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const body = await c.req.json<{
    company_id?: string;
    tipo_cfe?: number;
    rut_receptor?: string;
    razon_receptor?: string;
    concepto?: string;
    subtotal?: number;
    iva_tasa?: string;
    fecha_emision?: string;
  }>();

  if (!body.company_id?.trim()) return c.json({ error: "company_id es requerido." }, 400);
  if (!isValidTipoCfe(body.tipo_cfe)) {
    return c.json({ error: `tipo_cfe inválido. Valores válidos: ${VALID_TIPOS_CFE.join(", ")}.` }, 400);
  }
  if (!body.concepto?.trim()) return c.json({ error: "concepto es requerido." }, 400);
  if (typeof body.subtotal !== "number" || body.subtotal <= 0) {
    return c.json({ error: "subtotal debe ser un número positivo." }, 400);
  }
  if (!VALID_IVA_TASAS.includes(body.iva_tasa as IvaTasa)) {
    return c.json({ error: `iva_tasa inválida. Valores válidos: ${VALID_IVA_TASAS.join(", ")}.` }, 400);
  }

  // Validate receptor RUT (required for e-Factura 111/121; optional for e-Ticket 101)
  let rutReceptor: string | null = null;
  if (body.rut_receptor?.trim()) {
    rutReceptor = normalizeRut(body.rut_receptor);
    if (!rutReceptor) {
      return c.json({ error: "El RUT del receptor debe tener 12 dígitos (ej: 210000010018)." }, 400);
    }
  } else if (body.tipo_cfe === 111 || body.tipo_cfe === 121) {
    return c.json({ error: "El RUT del receptor es obligatorio para e-Factura (111) y e-Factura Exportación (121)." }, 400);
  }

  // Validate fecha_emision (not more than 72 h in the past)
  const fechaEmision = body.fecha_emision?.trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaEmision)) {
    return c.json({ error: "fecha_emision debe tener formato YYYY-MM-DD." }, 400);
  }
  const emisionTs = Date.parse(fechaEmision);
  if (isNaN(emisionTs)) return c.json({ error: "fecha_emision inválida." }, 400);
  const diffHours = (Date.now() - emisionTs) / 3_600_000;
  if (diffHours > 72) {
    return c.json({ error: "La fecha de emisión no puede ser mayor a 72 horas en el pasado." }, 400);
  }

  // Verify company ownership
  const company = await c.env.DB.prepare(
    "SELECT id, rut, razon_social FROM companies WHERE id = ? AND user_id = ?"
  ).bind(body.company_id.trim(), userId).first<{ id: string; rut: string; razon_social: string }>();
  if (!company) return c.json({ error: "Empresa no encontrada." }, 404);

  // Load CFE config
  const config = await c.env.DB.prepare(
    "SELECT id, ambiente, serie FROM cfe_configs WHERE company_id = ? AND user_id = ?"
  ).bind(company.id, userId).first<{ id: string; ambiente: string; serie: string }>();
  if (!config) {
    return c.json(
      { error: "La empresa no tiene configuración CFE. Configurá el ambiente y la serie primero en /app/facturacion/config." },
      422
    );
  }

  // IVA coherence check
  const ivaTasa = body.iva_tasa as IvaTasa;
  const montoIva  = calcIva(body.subtotal, ivaTasa);
  const total     = Math.round((body.subtotal + montoIva) * 100) / 100;

  // Persist the CFE in draft state first
  const docId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO cfe_documents
       (id, user_id, tenant_id, company_id, tipo_cfe, fecha_emision, rut_receptor,
        razon_receptor, concepto, subtotal, iva_tasa, monto_iva, total, estado, serie)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'borrador', ?)`
  ).bind(
    docId, userId, tenantId, company.id, body.tipo_cfe!, fechaEmision,
    rutReceptor,
    body.razon_receptor?.trim() || null,
    body.concepto.trim(),
    body.subtotal, ivaTasa, montoIva, total,
    config.serie
  ).run();

  // Attempt to send to UruFactura Container if configured
  if (!c.env.URUFACTURA_CONTAINER) {
    // Container not deployed — CFE saved as draft, return partial success
    return c.json({
      ok: true,
      draft: true,
      document: { id: docId, estado: "borrador", subtotal: body.subtotal, monto_iva: montoIva, total },
      warning: "CFE guardado como borrador. Para emitir ante DGI, el container UruFactura debe estar desplegado y configurado. Ver features/e-factura-integration.tech.md.",
    }, 202);
  }

  // Load CAEs for this company to pass to the container
  const caes = await c.env.DB.prepare(
    "SELECT tipo_cfe, serie, rango_desde, rango_hasta, ultimo_nro_usado, fecha_vencimiento FROM cfe_caes WHERE company_id = ?"
  ).bind(company.id).all();

  try {
    const containerId = c.env.URUFACTURA_CONTAINER.idFromName(company.id);
    const containerStub = c.env.URUFACTURA_CONTAINER.get(containerId);

    const cfePayload = {
      tipo: body.tipo_cfe,
      fecha_emision: fechaEmision,
      emisor: { rut: company.rut, razon_social: company.razon_social },
      receptor: rutReceptor ? { rut: rutReceptor, razon_social: body.razon_receptor?.trim() || "" } : null,
      concepto: body.concepto.trim(),
      subtotal: body.subtotal,
      iva_tasa: body.iva_tasa,
      monto_iva: montoIva,
      total,
      ambiente: config.ambiente,
      serie: config.serie,
    };

    const containerRes = await containerStub.fetch("http://internal/api/cfe/emit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Caes-Json": JSON.stringify(caes.results),
      },
      body: JSON.stringify(cfePayload),
    });

    if (!containerRes.ok) {
      const errBody = await containerRes.json().catch(() => ({})) as { error?: string };
      return c.json({ error: errBody.error ?? "Error al emitir el CFE ante DGI." }, 502);
    }

    const result = await containerRes.json() as {
      cae_numero?: string;
      numero?: number;
      xml_base64?: string;
      ultimo_nro_usado?: number;
    };

    // Store signed XML in R2 if available
    let xmlR2Key: string | null = null;
    if (result.xml_base64 && c.env.DOCUMENTS_BUCKET) {
      const xmlBytes = Uint8Array.from(atob(result.xml_base64), ch => ch.charCodeAt(0));
      xmlR2Key = `cfe/${userId}/${company.id}/${docId}.xml`;
      await c.env.DOCUMENTS_BUCKET.put(xmlR2Key, xmlBytes, {
        httpMetadata: { contentType: "application/xml" },
        customMetadata: { userId, companyId: company.id, docId },
      });
    }

    // Update CAE last used number (non-blocking)
    if (typeof result.ultimo_nro_usado === "number") {
      c.executionCtx?.waitUntil(
        c.env.DB.prepare(
          "UPDATE cfe_caes SET ultimo_nro_usado = ? WHERE company_id = ? AND tipo_cfe = ? AND serie = ?"
        ).bind(result.ultimo_nro_usado, company.id, body.tipo_cfe!, config.serie).run()
          .catch((err: unknown) => console.error("cfe_caes update failed:", err))
      );
    }

    // Mark CFE as enviado with the returned CAE and number
    await c.env.DB.prepare(
      `UPDATE cfe_documents SET
         estado = 'enviado', cae_numero = ?, numero = ?, cfe_xml_r2_key = ?,
         updated_at = strftime('%s', 'now')
       WHERE id = ?`
    ).bind(result.cae_numero ?? null, result.numero ?? null, xmlR2Key, docId).run();

    return c.json({
      ok: true,
      document: {
        id: docId,
        estado: "enviado",
        numero: result.numero,
        cae_numero: result.cae_numero,
        subtotal: body.subtotal,
        monto_iva: montoIva,
        total,
        has_xml: xmlR2Key !== null,
      },
    }, 201);
  } catch (err) {
    console.error("UruFactura container error:", err);
    // CFE remains as borrador — client can retry
    return c.json({ error: "Error al contactar el servicio de emisión. El CFE fue guardado como borrador y puede reintentarse." }, 502);
  }
});

// POST /api/cfe/documents/:id/annul  — request annulment of an emitted CFE
app.post("/api/cfe/documents/:id/annul", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");
  const id       = c.req.param("id");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const doc = await c.env.DB.prepare(
    "SELECT id, estado FROM cfe_documents WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{ id: string; estado: string }>();
  if (!doc) return c.json({ error: "CFE no encontrado." }, 404);

  if (doc.estado === "anulado") {
    return c.json({ error: "El CFE ya se encuentra anulado." }, 409);
  }
  if (doc.estado === "borrador") {
    return c.json({ error: "Un CFE en borrador no puede anularse (simplemente eliminalo)." }, 422);
  }

  await c.env.DB.prepare(
    "UPDATE cfe_documents SET estado = 'anulado', updated_at = strftime('%s', 'now') WHERE id = ?"
  ).bind(id).run();

  return c.json({ ok: true, message: "CFE marcado como anulado." });
});

// DELETE /api/cfe/documents/:id  — delete a draft CFE
app.delete("/api/cfe/documents/:id", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");
  const id       = c.req.param("id");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const doc = await c.env.DB.prepare(
    "SELECT id, estado, cfe_xml_r2_key FROM cfe_documents WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first<{ id: string; estado: string; cfe_xml_r2_key: string | null }>();
  if (!doc) return c.json({ error: "CFE no encontrado." }, 404);

  if (doc.estado !== "borrador") {
    return c.json({ error: "Solo se pueden eliminar CFEs en estado borrador. Para CFEs emitidos, usá la opción de anular." }, 422);
  }

  await c.env.DB.prepare("DELETE FROM cfe_documents WHERE id = ?").bind(id).run();

  if (doc.cfe_xml_r2_key && c.env.DOCUMENTS_BUCKET) {
    c.executionCtx?.waitUntil(
      c.env.DOCUMENTS_BUCKET.delete(doc.cfe_xml_r2_key).catch((err: unknown) =>
        console.error("R2 delete failed:", err)
      )
    );
  }

  return c.json({ ok: true });
});

// POST /api/cfe/generate-iva-book  — generate IVA book for a month and ingest it as a tax document
// Body: { company_id, month, year }
app.post("/api/cfe/generate-iva-book", requireAuth, async (c) => {
  const tenantId = c.get("tenantId");
  const userId   = c.get("userId");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["cfe_enabled"]) {
    return c.json({ error: "La emisión de CFEs no está habilitada." }, 503);
  }

  const body = await c.req.json<{ company_id?: string; month?: number; year?: number }>();
  const month = Number(body.month);
  const year  = Number(body.year);

  if (!body.company_id?.trim()) return c.json({ error: "company_id es requerido." }, 400);
  if (!month || !year || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return c.json({ error: "Mes (1-12) y año (>= 2000) son requeridos." }, 400);
  }

  const company = await c.env.DB.prepare(
    "SELECT id, razon_social, rut FROM companies WHERE id = ? AND user_id = ?"
  ).bind(body.company_id.trim(), userId).first<{ id: string; razon_social: string; rut: string }>();
  if (!company) return c.json({ error: "Empresa no encontrada." }, 404);

  // Query all non-annulled CFEs for the month
  const isoStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay  = new Date(year, month, 0).getDate();
  const isoEnd   = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const cfes = await c.env.DB.prepare(
    `SELECT tipo_cfe, numero, serie, fecha_emision, rut_receptor, razon_receptor,
            concepto, subtotal, iva_tasa, monto_iva, total, estado
     FROM cfe_documents
     WHERE company_id = ? AND user_id = ?
       AND fecha_emision >= ? AND fecha_emision <= ?
       AND estado != 'anulado'
     ORDER BY fecha_emision ASC, numero ASC`
  ).bind(company.id, userId, isoStart, isoEnd).all<{
    tipo_cfe: number; numero: number | null; serie: string | null;
    fecha_emision: string; rut_receptor: string | null; razon_receptor: string | null;
    concepto: string; subtotal: number; iva_tasa: string;
    monto_iva: number; total: number; estado: string;
  }>();

  if (cfes.results.length === 0) {
    return c.json({ error: `No hay CFEs emitidos para ${company.razon_social} en el período ${month}/${year}.` }, 422);
  }

  // Aggregate by IVA rate for the book
  const totales: Record<string, { base: number; iva: number; total: number; cantidad: number }> = {};
  for (const cfe of cfes.results) {
    const tasa = cfe.iva_tasa;
    if (!totales[tasa]) totales[tasa] = { base: 0, iva: 0, total: 0, cantidad: 0 };
    totales[tasa].base  += cfe.subtotal;
    totales[tasa].iva   += cfe.monto_iva;
    totales[tasa].total += cfe.total;
    totales[tasa].cantidad++;
  }

  const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const label = `${MONTH_NAMES[month - 1]} ${year}`;

  // Escape a value for CSV: prevent formula injection and quote fields with special chars
  const csvField = (value: string): string => {
    if (/^[=+\-@\t\r]/.test(value)) value = "'" + value;
    if (/[,"\n\r]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
    return value;
  };

  // Build CSV content
  const lines: string[] = [
    csvField(`Libro IVA Ventas — ${company.razon_social} (RUT: ${company.rut}) — ${label}`),
    "",
    "Fecha,Tipo CFE,Número,Receptor RUT,Receptor,Concepto,Subtotal,Tasa IVA,IVA,Total,Estado",
  ];
  for (const cfe of cfes.results) {
    lines.push([
      csvField(cfe.fecha_emision),
      csvField(TIPOS_CFE_LABELS[cfe.tipo_cfe] ?? String(cfe.tipo_cfe)),
      csvField(`${cfe.serie ?? ""}${cfe.numero ?? ""}`),
      csvField(cfe.rut_receptor ?? ""),
      csvField(cfe.razon_receptor ?? "Consumidor Final"),
      csvField(cfe.concepto),
      csvField(cfe.subtotal.toFixed(2)),
      csvField(cfe.iva_tasa === "exento" ? "Exento" : `${cfe.iva_tasa}%`),
      csvField(cfe.monto_iva.toFixed(2)),
      csvField(cfe.total.toFixed(2)),
      csvField(cfe.estado),
    ].join(","));
  }

  lines.push("");
  lines.push("RESUMEN POR TASA:");
  for (const [tasa, totalesTasa] of Object.entries(totales)) {
    const tasaLabel = tasa === "exento" ? "Exento" : `IVA ${tasa}%`;
    lines.push([
      csvField(tasaLabel),
      csvField(`Cantidad: ${totalesTasa.cantidad}`),
      csvField(`Base: ${totalesTasa.base.toFixed(2)}`),
      csvField(`IVA: ${totalesTasa.iva.toFixed(2)}`),
      csvField(`Total: ${totalesTasa.total.toFixed(2)}`),
    ].join(","));
  }

  const grandTotal = cfes.results.reduce((s, c) => s + c.total, 0);
  lines.push(["TOTAL GENERAL", csvField(`${cfes.results.length} CFEs`), "", csvField(grandTotal.toFixed(2))].join(","));

  const csvContent = lines.join("\n");

  // Find or create the tax_period for this month/company
  let periodId: string | null = await c.env.DB.prepare(
    "SELECT id FROM tax_periods WHERE user_id = ? AND month = ? AND year = ? AND company_id = ?"
  ).bind(userId, month, year, company.id).first<{ id: string }>().then(r => r?.id ?? null);

  if (!periodId) {
    periodId = crypto.randomUUID();
    try {
      await c.env.DB.prepare(
        `INSERT INTO tax_periods (id, user_id, tenant_id, month, year, label, company_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(periodId, userId, tenantId, month, year, label, company.id).run();
    } catch {
      // Already exists with different company — look it up without company filter
      const found = await c.env.DB.prepare(
        "SELECT id FROM tax_periods WHERE user_id = ? AND month = ? AND year = ? AND company_id IS NULL"
      ).bind(userId, month, year).first<{ id: string }>();
      periodId = found?.id ?? null;
      if (!periodId) {
        return c.json({ error: "No se pudo crear o encontrar el período fiscal correspondiente." }, 500);
      }
    }
  }

  // Upsert the IVA book document in the period
  const filename = `libro_iva_ventas_${year}_${String(month).padStart(2, "0")}_${company.rut}.csv`;
  const existingDoc = await c.env.DB.prepare(
    "SELECT id FROM tax_documents WHERE period_id = ? AND doc_type = 'libro_iva_ventas' AND user_id = ?"
  ).bind(periodId, userId).first<{ id: string }>();

  if (existingDoc) {
    await c.env.DB.prepare(
      "UPDATE tax_documents SET content = ?, filename = ? WHERE id = ?"
    ).bind(csvContent, filename, existingDoc.id).run();
  } else {
    const docId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO tax_documents (id, period_id, user_id, filename, content, doc_type, source)
       VALUES (?, ?, ?, ?, ?, 'libro_iva_ventas', 'cfe_auto')`
    ).bind(docId, periodId, userId, filename, csvContent).run();
  }

  // Update CFEs with period_id (non-blocking)
  c.executionCtx?.waitUntil(
    c.env.DB.prepare(
      `UPDATE cfe_documents SET periodo_id = ?
       WHERE company_id = ? AND user_id = ?
         AND fecha_emision >= ? AND fecha_emision <= ?
         AND estado != 'anulado'`
    ).bind(periodId, company.id, userId, isoStart, isoEnd).run()
      .catch((err: unknown) => console.error("cfe_documents period update failed:", err))
  );

  return c.json({
    ok: true,
    period_id: periodId,
    filename,
    cfe_count: cfes.results.length,
    total_general: grandTotal,
    message: `Libro IVA Ventas generado con ${cfes.results.length} CFEs. Podés verlo en el período ${label} en la sección Impuestos.`,
  });
});



app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
