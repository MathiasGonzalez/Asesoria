-- Tax situation analysis: monthly periods, uploaded documents, and AI consolidation results.

CREATE TABLE IF NOT EXISTS tax_periods (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  tenant_id  TEXT    NOT NULL,
  month      INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  year       INTEGER NOT NULL CHECK(year >= 2000),
  label      TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'draft',
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(user_id, month, year),
  FOREIGN KEY(user_id)   REFERENCES users(id)   ON DELETE CASCADE,
  FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tax_documents (
  id         TEXT    PRIMARY KEY,
  period_id  TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  filename   TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  doc_type   TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(period_id) REFERENCES tax_periods(id)  ON DELETE CASCADE,
  FOREIGN KEY(user_id)   REFERENCES users(id)         ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tax_consolidations (
  id           TEXT    PRIMARY KEY,
  period_id    TEXT    NOT NULL UNIQUE,
  raw_response TEXT    NOT NULL,
  created_at   INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(period_id) REFERENCES tax_periods(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tax_periods_user     ON tax_periods(user_id, year DESC, month DESC);
CREATE INDEX IF NOT EXISTS idx_tax_docs_period      ON tax_documents(period_id);
CREATE INDEX IF NOT EXISTS idx_tax_consol_period    ON tax_consolidations(period_id);
