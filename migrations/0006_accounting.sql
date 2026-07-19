-- Accounting firm expansion: company profiles linked to tax periods.

CREATE TABLE IF NOT EXISTS companies (
  id                TEXT    PRIMARY KEY,
  user_id           TEXT    NOT NULL,
  tenant_id         TEXT    NOT NULL,
  rut               TEXT    NOT NULL,
  razon_social      TEXT    NOT NULL,
  nombre_comercial  TEXT,
  tipo_entidad      TEXT    NOT NULL DEFAULT 'srl',
  regimen_irae      TEXT    NOT NULL DEFAULT 'real',
  actividad         TEXT,
  bps_nro_patronal  TEXT,
  domicilio_fiscal  TEXT,
  created_at        INTEGER DEFAULT (strftime('%s', 'now')),
  updated_at        INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(user_id, rut),
  FOREIGN KEY(user_id)   REFERENCES users(id)   ON DELETE CASCADE,
  FOREIGN KEY(tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Link tax periods to a company profile (optional) and allow free-text notes
ALTER TABLE tax_periods ADD COLUMN notas      TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_user ON companies(user_id);
