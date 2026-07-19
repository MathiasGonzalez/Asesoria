/**
 * RagService — Retrieval-Augmented Generation pipeline for Uruguayan legal corpus.
 *
 * ## Overview
 * Implements a **hybrid search** strategy that combines:
 * - **Semantic search** via Cloudflare Vectorize (model: `@cf/baai/bge-m3`, 1024 dims,
 *   multilingual, supports Spanish legal text).
 * - **Lexical search** via SQLite FTS5 (`document_chunks_fts`) for keyword precision.
 *
 * Merged results are fetched from D1, formatted with source attribution (document
 * title, source name, and URL), and returned as a context string for the LLM prompt.
 *
 * ## Ingestion pipeline
 * `ingestDocument` implements **Contextual RAG** (Anthropic's technique):
 * 1. Splits the document into ≤1 000-char paragraph chunks.
 * 2. For each chunk, calls `@cf/meta/llama-3-8b-instruct` to generate a 1–2 sentence
 *    contextual summary situating the chunk within the full document.
 * 3. Embeds `contextSummary + chunkText` via `@cf/baai/bge-m3`.
 * 4. Stores chunks + summaries in D1; batch-upserts all vectors to Vectorize in a
 *    single round-trip.
 *
 * ## Content limit
 * Maximum ingested content per call: 20 000 characters (enforced by the route handler).
 * This prevents CPU time overruns from large documents processed chunk by chunk.
 */
export interface Env {
  /** D1 database — stores documents, chunks, and the FTS5 virtual table. */
  DB: D1Database;
  /** Vectorize index — holds 1024-dim bge-m3 embeddings for semantic retrieval. */
  VECTORIZE: VectorizeIndex;
  /** Workers AI binding — used for embedding (`bge-m3`) and generation (`llama-3-8b`). */
  AI: Ai;
}

export class RagService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Strips FTS5 boolean operators and special characters from a user query
   * to prevent parse errors when passed to MATCH.
   */
  private static escapeFts5(query: string): string {
    return query
      .replace(/["*^()]/g, ' ')
      .replace(/\b(AND|OR|NOT)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Splits content on paragraph boundaries (double newline), falling back to
   * hard character splits for paragraphs that exceed maxSize.
   */
  private static chunkContent(content: string, maxSize: number = 1000): string[] {
    const paragraphs = content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      const would = current ? current.length + 2 + para.length : para.length;
      if (would <= maxSize) {
        current = current ? `${current}\n\n${para}` : para;
      } else {
        if (current) chunks.push(current);
        if (para.length > maxSize) {
          for (let i = 0; i < para.length; i += maxSize) {
            chunks.push(para.slice(i, i + maxSize));
          }
          current = '';
        } else {
          current = para;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [content.slice(0, maxSize)];
  }

  /**
   * Hybrid search: semantic (Vectorize bge-m3) + lexical (FTS5).
   * Pass useHybrid=false to skip FTS5 (controlled via feature flag).
   */
  public async searchNormative(userQuery: string, limit: number = 3, useHybrid: boolean = true): Promise<string> {
    // Multilingual embedding (1024 dims, Spanish + English corpus support)
    const embeddingResponse = await this.env.AI.run("@cf/baai/bge-m3", {
      text: [userQuery]
    }) as { data: number[][] };

    const queryVector = embeddingResponse.data[0];

    // Semantic retrieval from Vectorize
    const vectorMatches = await this.env.VECTORIZE.query(queryVector, {
      topK: limit,
      returnMetadata: "all"
    });

    const semIds = vectorMatches.matches.map((m) => m.id);
    let ftsIds: string[] = [];

    if (useHybrid) {
      const escapedQuery = RagService.escapeFts5(userQuery);
      if (escapedQuery.length > 0) {
        const ftsResults = await this.env.DB.prepare(
          "SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH ? LIMIT ?"
        ).bind(escapedQuery, limit).all<{ chunk_id: string }>();
        ftsIds = ftsResults.results.map((row) => String(row.chunk_id));
      }
    }

    // Combine and fetch full text details
    const allIds = Array.from(new Set([...semIds, ...ftsIds]));
    if (allIds.length === 0) {
      return "No se encontró contexto regulatorio aplicable.";
    }

    const placeholders = allIds.map(() => "?").join(",");
    const queryStr = `
      SELECT dc.chunk_text, dc.context_summary, d.title, d.source, d.url
      FROM document_chunks dc
      JOIN documents d ON dc.document_id = d.id
      WHERE dc.id IN (${placeholders})
    `;

    const dbRows = await this.env.DB.prepare(queryStr).bind(...allIds).all<{
      chunk_text: string;
      context_summary: string | null;
      title: string;
      source: string;
      url: string | null;
    }>();

    return dbRows.results.map((row) => {
      const url = row.url ?? "No provisto";
      return `[Origen: ${row.source} | Documento: ${row.title} | Enlace: ${url}]\nContexto: ${row.context_summary ?? ""}\nFragmento: ${row.chunk_text}\n---`;
    }).join("\n\n");
  }

  /**
   * Contextual RAG ingestion of new documents.
   * Stores only a 500-char preview in `documents.content`; full text lives in chunks.
   * Batches all Vectorize upserts into a single call at the end.
   */
  public async ingestDocument(id: string, title: string, source: string, content: string, url: string): Promise<void> {
    // Store a preview — full text is already chunked below
    await this.env.DB.prepare(
      "INSERT INTO documents (id, title, source, content, url) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, title, source, content.substring(0, 500), url).run();

    const chunks = RagService.chunkContent(content);
    const vectors: { id: string; values: number[]; metadata: Record<string, string> }[] = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunkText = chunks[index];
      const chunkId = `${id}_chunk_${index}`;

      // Contextualize the chunk by situating it within the overall document
      const contextualizePrompt =
        `Eres un experto en normativa tributaria uruguaya. ` +
        `Describe en 1-2 oraciones en español cómo el siguiente fragmento se ubica dentro del documento "${title}".\n` +
        `Contexto del documento: ${content.substring(0, 800)}...\n` +
        `Fragmento: ${chunkText}`;

      const aiContextResponse = await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: "Responde de forma concisa y directa únicamente en español." },
          { role: "user", content: contextualizePrompt }
        ]
      }) as { response?: string };

      const contextSummary = aiContextResponse.response ?? "Contexto general regulatorio.";

      await this.env.DB.prepare(
        "INSERT INTO document_chunks (id, document_id, chunk_text, context_summary) VALUES (?, ?, ?, ?)"
      ).bind(chunkId, id, chunkText, contextSummary).run();

      // Embed using multilingual model (1024 dims, bge-m3)
      const embeddingText = `${contextSummary} ${chunkText}`;
      const embeddingResponse = await this.env.AI.run("@cf/baai/bge-m3", {
        text: [embeddingText]
      }) as { data: number[][] };

      vectors.push({
        id: chunkId,
        values: embeddingResponse.data[0],
        metadata: { document_id: id, source }
      });
    }

    // Single batch upsert — one round-trip to Vectorize regardless of chunk count
    if (vectors.length > 0) {
      await this.env.VECTORIZE.upsert(vectors);
    }
  }

  /**
   * Removes a document and all its chunks from D1 and Vectorize.
   */
  public async deleteDocument(id: string): Promise<void> {
    // Collect chunk IDs before the cascade delete removes them
    const chunks = await this.env.DB.prepare(
      "SELECT id FROM document_chunks WHERE document_id = ?"
    ).bind(id).all<{ id: string }>();

    const chunkIds = chunks.results.map(r => r.id);

    if (chunkIds.length > 0) {
      await this.env.VECTORIZE.deleteByIds(chunkIds);
    }

    // DELETE cascades to document_chunks via FK
    await this.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
  }
}
