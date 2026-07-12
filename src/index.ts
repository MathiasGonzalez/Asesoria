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
// Serve static frontend assets
// ---------------------------------------------------------------------------

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
