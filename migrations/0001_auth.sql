-- Tenants table (created on first user registration per domain)
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Users table (email is the unique identity)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- OTP codes for passwordless email authentication
CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Sessions created after successful OTP verification
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Feature flags (tenant_id IS NULL = global default; tenant-specific rows override global)
CREATE TABLE IF NOT EXISTS feature_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(tenant_id, name)
);

-- Seed global default feature flags
INSERT OR IGNORE INTO feature_flags (tenant_id, name, enabled, metadata) VALUES
  (NULL, 'ai_search_enabled',           1, '{"description":"Habilita búsqueda con IA"}'),
  (NULL, 'document_ingestion_enabled',  1, '{"description":"Habilita ingestión de documentos"}'),
  (NULL, 'hybrid_search_enabled',       1, '{"description":"Usa búsqueda híbrida vectorial+FTS5"}'),
  (NULL, 'otp_auth_enabled',            1, '{"description":"Requiere autenticación OTP por email"}');

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_otp_email    ON otp_codes(email, used, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
