-- Versioned terms & conditions consent log
-- Each row records when a user accepted a specific version of the T&C.
-- UNIQUE(user_id, terms_version) ensures idempotency on re-login.
CREATE TABLE IF NOT EXISTS terms_consents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  terms_version TEXT   NOT NULL,
  accepted_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  ip           TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, terms_version)
);

CREATE INDEX IF NOT EXISTS idx_consents_user ON terms_consents(user_id);
