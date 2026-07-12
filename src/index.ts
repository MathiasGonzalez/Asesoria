import { Hono, type MiddlewareHandler } from "hono";
import { Anonymizer } from "./services/anonymizer.js";
import { RagService } from "./services/rag.js";
import { AuthService } from "./services/auth.js";
import { EmailService } from "./services/email.js";
import { FeatureFlagsService } from "./services/featureFlags.js";

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Bindings {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  RATE_LIMITER: RateLimit;
  EMAIL_API_KEY: string;
  EMAIL_FROM: string;
}

type Variables = {
  userId: string;
  tenantId: string;
  email: string;
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

    return next();
  };

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
  const body = await c.req.json<{ email?: string; code?: string }>();
  const email = body.email?.trim().toLowerCase();
  const code = body.code?.trim();

  if (!email || !code) {
    return c.json({ error: "Email y código son requeridos." }, 400);
  }

  const authService = new AuthService(c.env);

  let result: { sessionToken: string; isNewUser: boolean };
  try {
    result = await authService.verifyOtp(email, code);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error de verificación.";
    return c.json({ error: message }, 401);
  }

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
// GET /api/search  (requires auth)
// ---------------------------------------------------------------------------

app.get("/api/search", requireAuth, async (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "El parámetro q es requerido." }, 400);

  const tenantId = c.get("tenantId");

  const ffService = new FeatureFlagsService(c.env);
  const flags = await ffService.getFlags(tenantId);
  if (!flags["ai_search_enabled"]) {
    return c.json(
      { error: "La búsqueda con IA está temporalmente deshabilitada." },
      503
    );
  }

  const startTime = Date.now();
  const cleanQuery = Anonymizer.sanitize(query);

  const rag = new RagService(c.env);
  const context = await rag.searchNormative(cleanQuery);

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

  return c.json({
    originalQuery: query,
    sanitizedQuery: cleanQuery,
    response: aiResponse.response ?? "Disculpas, no pudimos procesar la consulta.",
    latencyMs: Date.now() - startTime,
  });
});

// ---------------------------------------------------------------------------
// POST /api/ingest  (requires auth)
// ---------------------------------------------------------------------------

app.post("/api/ingest", requireAuth, async (c) => {
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
