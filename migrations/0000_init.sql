-- Create core documentation tables
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  context_summary TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Setup SQLite FTS5 Virtual Table for Hybrid Search
CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
  chunk_id,
  text_content,
  tokenize='unicode61'
);

-- Triggers to maintain the FTS index automatically
CREATE TRIGGER IF NOT EXISTS after_chunk_insert AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(chunk_id, text_content)
  VALUES (new.id, COALESCE(new.context_summary, '') || ' ' || new.chunk_text);
END;

CREATE TRIGGER IF NOT EXISTS after_chunk_delete AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
END;
