import { Hono } from "hono";
import { Anonymizer } from "./services/anonymizer.js";
import { RagService } from "./services/rag.js";

interface Bindings {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Bindings }>();

// API Search Endpoint
app.get("/api/search", async (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "Query parameters are required." }, 400);

  const startTime = Date.now();

  // Clean PII before processing queries
  const cleanQuery = Anonymizer.sanitize(query);

  const rag = new RagService(c.env);
  const context = await rag.searchNormative(cleanQuery);

  // Generate answering payload with high-reasoning model
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

  const aiResponse = await c.env.AI.run("@cf/qwen/qwq-32b", {
    messages: [
      { role: "system", content: "Eres una inteligencia artificial grounded que responde basándose únicamente en el contexto provisto." },
      { role: "user", content: prompt }
    ]
  }) as { response?: string };

  const responseText = aiResponse.response ?? "Disculpas, no pudimos procesar la consulta.";

  return c.json({
    originalQuery: query,
    sanitizedQuery: cleanQuery,
    response: responseText,
    latencyMs: Date.now() - startTime
  });
});

// Secure Documents Ingestion Endpoint
app.post("/api/ingest", async (c) => {
  const body = await c.req.json();
  const { id, title, source, content, url } = body as {
    id?: string;
    title?: string;
    source?: string;
    content?: string;
    url?: string;
  };

  if (!id || !title || !source || !content) {
    return c.json({ error: "Missing required ingestion payload fields" }, 400);
  }

  const rag = new RagService(c.env);
  await rag.ingestDocument(id, title, source, content, url || "");

  return c.json({ success: true, message: `Document '${title}' ingested and contextualized successfully.` });
});

// Serve frontend static assets
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
