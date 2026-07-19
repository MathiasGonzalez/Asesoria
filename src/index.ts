import { Hono, type MiddlewareHandler } from "hono";
import { Anonymizer } from "./services/anonymizer.js";
import { RagService } from "./services/rag.js";
import { AuthService } from "./services/auth.js";
import { EmailService, type SendEmailBinding } from "./services/email.js";
import { FeatureFlagsService } from "./services/featureFlags.js";

// Bump this string whenever the T&C text changes to force re-acceptance.
const CURRENT_TERMS_VERSION = "1.0";

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Bindings {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  RATE_LIMITER: RateLimit;
  EMAIL_SEND?: SendEmailBinding;
  EMAIL_API_KEY?: string;
  EMAIL_FROM: string;
  DOCUMENTS_BUCKET?: R2Bucket;
}

type Variables = {
  userId: string;
  tenantId: string;
  email: string;
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
// Serve static frontend assets
// ---------------------------------------------------------------------------

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
