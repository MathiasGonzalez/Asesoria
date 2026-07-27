-- CFE (Comprobantes Fiscales Electrónicos) — e-Factura integration.
-- Stores per-company configuration, CAE ranges, and emitted/received CFE records.

-- Per-company CFE configuration (ambiente, serie, encrypted certificate).
CREATE TABLE IF NOT EXISTS cfe_configs (
  id                  TEXT    PRIMARY KEY,
  user_id             TEXT    NOT NULL,
  tenant_id           TEXT    NOT NULL,
  company_id          TEXT    NOT NULL UNIQUE,
  ambiente            TEXT    NOT NULL DEFAULT 'homologacion', -- homologacion | produccion
  serie               TEXT    NOT NULL DEFAULT 'A',
  serie_inicio        INTEGER NOT NULL DEFAULT 1,
  -- Certificate stored AES-256-GCM encrypted (same key as PORTAL_ENCRYPTION_KEY)
  certificado_b64_enc TEXT,  -- encrypted .p12 in base64
  certificado_iv      TEXT,  -- base64 GCM IV for the certificate
  created_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(user_id)    REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- CAE ranges assigned by DGI — persisted so the UruFactura container can resume after sleep.
CREATE TABLE IF NOT EXISTS cfe_caes (
  id                 TEXT    PRIMARY KEY,
  company_id         TEXT    NOT NULL,
  tipo_cfe           INTEGER NOT NULL,   -- 101 | 111 | 112 | 121 | 151 | 181 | 102
  serie              TEXT    NOT NULL,
  rango_desde        INTEGER NOT NULL,
  rango_hasta        INTEGER NOT NULL,
  ultimo_nro_usado   INTEGER NOT NULL DEFAULT 0,
  fecha_vencimiento  TEXT,               -- ISO date YYYY-MM-DD
  created_at         INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(company_id, tipo_cfe, serie),
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Emitted and received CFE documents.
CREATE TABLE IF NOT EXISTS cfe_documents (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL,
  tenant_id        TEXT    NOT NULL,
  company_id       TEXT    NOT NULL,
  tipo_cfe         INTEGER NOT NULL,   -- 101 | 111 | 112 | 121 | 151 | 181 | 102
  numero           INTEGER,
  serie            TEXT,
  fecha_emision    TEXT    NOT NULL,   -- ISO date YYYY-MM-DD
  rut_receptor     TEXT,
  razon_receptor   TEXT,
  concepto         TEXT    NOT NULL,
  subtotal         REAL    NOT NULL,
  iva_tasa         TEXT    NOT NULL DEFAULT '22',  -- '22' | '10' | '0' | 'exento'
  monto_iva        REAL    NOT NULL,
  total            REAL    NOT NULL,
  estado           TEXT    NOT NULL DEFAULT 'borrador', -- borrador | enviado | aceptado | rechazado | anulado
  cfe_xml_r2_key   TEXT,   -- signed XML stored in R2
  cae_numero       TEXT,   -- code assigned by DGI
  periodo_id       TEXT,   -- FK to tax_periods (for automatic IVA book)
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(user_id)    REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cfe_docs_company_period ON cfe_documents(company_id, fecha_emision);
CREATE INDEX IF NOT EXISTS idx_cfe_docs_user_estado     ON cfe_documents(user_id, estado);
CREATE INDEX IF NOT EXISTS idx_cfe_caes_company         ON cfe_caes(company_id, tipo_cfe);

-- Global feature flag — disabled by default until UruFactura container is deployed.
INSERT OR IGNORE INTO feature_flags (tenant_id, name, enabled, metadata) VALUES
  (NULL, 'cfe_enabled', 0, '{"description":"Habilita emisión y gestión de CFEs (e-Factura, e-Ticket)"}');
