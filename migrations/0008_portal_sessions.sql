-- DGI/BPS portal session storage.
-- Stores AES-256-GCM encrypted session cookies per company per portal so the
-- Browser Rendering service can resume an existing session without re-login.
-- portal: 'dgi' | 'bps'
-- encrypted_cookies: base64-encoded AES-256-GCM ciphertext of a JSON cookies array
-- cookies_iv: base64-encoded 12-byte GCM IV

CREATE TABLE IF NOT EXISTS portal_sessions (
  id                      TEXT    PRIMARY KEY,
  company_id              TEXT    NOT NULL,
  user_id                 TEXT    NOT NULL,
  portal                  TEXT    NOT NULL CHECK(portal IN ('dgi', 'bps')),
  encrypted_cookies       TEXT    NOT NULL,
  cookies_iv              TEXT    NOT NULL,
  session_established_at  INTEGER NOT NULL,
  last_used_at            INTEGER,
  created_at              INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at              INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(company_id, portal),
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id)    REFERENCES users(id)     ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_user ON portal_sessions(user_id, portal);
