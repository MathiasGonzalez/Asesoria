export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
}

export class RagService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Performs a Hybrid Search combining Semantic Vector Search and SQLite FTS5 Keyword Search
   */
  public async searchNormative(userQuery: string, limit: number = 3): Promise<string> {
    // Generate embed of the query using standard bge model (768 dimensions)
    const embeddingResponse = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: [userQuery]
    }) as { data: number[][] };

    const queryVector = embeddingResponse.data[0];

    // Semantic retrieval from Vectorize
    const vectorMatches = await this.env.VECTORIZE.query(queryVector, {
      topK: limit,
      returnMetadata: "all"
    });

    const semIds = vectorMatches.matches.map((m) => m.id);

    // Lexical retrieval from D1 FTS5
    const ftsResults = await this.env.DB.prepare(
      "SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH ? LIMIT ?"
    ).bind(userQuery, limit).all<{ chunk_id: string }>();

    const ftsIds = ftsResults.results.map((row) => String(row.chunk_id));

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

    // Construct Contextualized strings
    return dbRows.results.map((row) => {
      const source = row.source;
      const title = row.title;
      const context = row.context_summary ?? "";
      const text = row.chunk_text;
      const url = row.url ?? "No provisto";
      return `[Origen: ${source} | Documento: ${title} | Enlace: ${url}]\nContexto: ${context}\nFragmento: ${text}\n---`;
    }).join("\n\n");
  }

  /**
   * Contextual RAG ingestion of new documents
   */
  public async ingestDocument(id: string, title: string, source: string, content: string, url: string): Promise<void> {
    // Save master document to D1
    await this.env.DB.prepare(
      "INSERT INTO documents (id, title, source, content, url) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, title, source, content, url).run();

    // Simple chunking (500 chars window) - For production consider semantic chunking
    const chunks: string[] = [];
    const windowSize = 500;
    for (let i = 0; i < content.length; i += windowSize) {
      chunks.push(content.substring(i, i + windowSize));
    }

    for (let index = 0; index < chunks.length; index++) {
      const chunkText = chunks[index];
      const chunkId = `${id}_chunk_${index}`;

      // Contextualize the chunk via AI model by situating it in the overall document context
      const contextualizePrompt = `
        You are an expert Uruguayan tax assistant. Describe how the following chunk fits within the overall document titled "${title}".
        Provide a concise context (max 2 sentences) in Spanish to prevent semantic loss during chunking.
        Overall Document Context: ${content.substring(0, 800)}...
        Chunk: ${chunkText}
      `;

      const aiContextResponse = await this.env.AI.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: "Responde de forma concisa y directa únicamente en español." },
          { role: "user", content: contextualizePrompt }
        ]
      }) as { response?: string };

      const contextSummary = aiContextResponse.response ?? "Contexto general regulatorio.";

      // Save chunk database record
      await this.env.DB.prepare(
        "INSERT INTO document_chunks (id, document_id, chunk_text, context_summary) VALUES (?, ?, ?, ?)"
      ).bind(chunkId, id, chunkText, contextSummary).run();

      // Generate vectorized embedding of Contextualized Chunk
      const embeddingText = `${contextSummary} ${chunkText}`;
      const embeddingResponse = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: [embeddingText]
      }) as { data: number[][] };

      const chunkVector = embeddingResponse.data[0];

      // Upsert vector to Vectorize index
      await this.env.VECTORIZE.upsert([{
        id: chunkId,
        values: chunkVector,
        metadata: { document_id: id, source }
      }]);
    }
  }
}
