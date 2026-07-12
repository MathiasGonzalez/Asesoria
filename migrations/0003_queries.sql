-- Query history: persists every AI-answered consultation per user/tenant.
-- Enables audit trail, review of prior criteria, and cumplimiento Art. 47 CT.
CREATE TABLE IF NOT EXISTS queries (
  id              TEXT    PRIMARY KEY,
  user_id         TEXT    NOT NULL,
  tenant_id       TEXT    NOT NULL,
  original_query  TEXT    NOT NULL,
  sanitized_query TEXT    NOT NULL,
  response        TEXT    NOT NULL,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(user_id)   REFERENCES users(id)   ON DELETE CASCADE,
  FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queries_user   ON queries(user_id,   created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queries_tenant ON queries(tenant_id, created_at DESC);
