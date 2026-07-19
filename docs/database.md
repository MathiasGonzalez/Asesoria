# Adviser — Database Schema Reference

Adviser uses **Cloudflare D1** (SQLite) as its primary relational store.
Migrations live in the [`migrations/`](../migrations/) directory and are applied in
numerical order by Wrangler.

All timestamps are stored as **Unix epoch seconds** (`INTEGER`) using
`strftime('%s', 'now')` as the default.

---

## Migration history

| File | Description |
|------|-------------|
| `0000_init.sql` | Core RAG corpus tables (`documents`, `document_chunks`, FTS5 index, triggers) |
| `0001_auth.sql` | Auth tables (`tenants`, `users`, `otp_codes`, `sessions`, `feature_flags`) + seed flags |
| `0002_terms_consents.sql` | T&C acceptance audit log (`terms_consents`) |
| `0003_queries.sql` | AI query history (`queries`) |
| `0004_roles.sql` | RBAC role column on `users` + admin promotion backfill |
| `0005_tax_analysis.sql` | Tax analysis tables (`tax_periods`, `tax_documents`, `tax_consolidations`) |
| `0006_accounting.sql` | Company profiles (`companies`) + `company_id`/`notas` columns on `tax_periods` |
| `0007_r2_documents.sql` | R2 storage columns on `tax_documents` (`r2_key`, `mime_type`, `file_size`, `source`, `source_url`) |
| `0008_portal_sessions.sql` | DGI/BPS portal session storage (`portal_sessions`) |

---

## Tables

### `tenants`

One row per organization. Created automatically on first login for any given email domain.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `name` | TEXT | NOT NULL | Typically the email domain (e.g. `"ejemplo.com.uy"`) |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

---

### `users`

One row per unique email address. First user in a tenant is created with role `admin`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `email` | TEXT | NOT NULL, UNIQUE | Verified email address |
| `tenant_id` | TEXT | NOT NULL, FK → `tenants.id` | Owning tenant |
| `role` | TEXT | NOT NULL, DEFAULT `'viewer'` | RBAC role: `'admin'` or `'viewer'` |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

**Indexes**: `idx_users_email` on `(email)`

---

### `otp_codes`

Short-lived one-time passwords for passwordless login. Codes expire after **10 minutes**;
only one active code per email exists at a time (previous unused codes are invalidated before issuing a new one).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `email` | TEXT | NOT NULL | Target email address |
| `code` | TEXT | NOT NULL | 6-digit numeric OTP |
| `expires_at` | INTEGER | NOT NULL | Unix timestamp (10 min after creation) |
| `used` | INTEGER | NOT NULL, DEFAULT `0` | `1` once consumed |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

**Indexes**: `idx_otp_email` on `(email, used, expires_at)`

---

### `sessions`

Active authenticated sessions. Tokens expire after **24 hours** and are deleted on logout.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Session token (UUID, sent to client) |
| `user_id` | TEXT | NOT NULL, FK → `users.id` | Owning user |
| `tenant_id` | TEXT | NOT NULL | Denormalized for fast lookups |
| `expires_at` | INTEGER | NOT NULL | Unix timestamp |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

**Indexes**: `idx_sessions_exp` on `(expires_at)` (for cleanup queries)

---

### `terms_consents`

Immutable audit log of T&C acceptances. The `UNIQUE(user_id, terms_version)` constraint
makes re-login idempotent — accepting the same version twice is silently ignored.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PK AUTOINCREMENT | Surrogate key |
| `user_id` | TEXT | NOT NULL, FK → `users.id` | Consenting user |
| `terms_version` | TEXT | NOT NULL | T&C version string (e.g. `"1.0"`) |
| `accepted_at` | INTEGER | NOT NULL, DEFAULT now | Unix timestamp |
| `ip` | TEXT | | Client IP (from `CF-Connecting-IP`) |

**Constraints**: `UNIQUE(user_id, terms_version)`
**Indexes**: `idx_consents_user` on `(user_id)`

---

### `feature_flags`

Feature toggle store. Rows with `tenant_id IS NULL` are global defaults; rows with a
specific `tenant_id` override the global value for that tenant.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PK AUTOINCREMENT | Surrogate key |
| `tenant_id` | TEXT | NULLABLE | `NULL` = global; UUID = tenant override |
| `name` | TEXT | NOT NULL | Flag name (e.g. `"ai_search_enabled"`) |
| `enabled` | INTEGER | NOT NULL, DEFAULT `1` | `1` = enabled, `0` = disabled |
| `metadata` | TEXT | | JSON string with human-readable description |
| `updated_at` | INTEGER | DEFAULT now | Unix timestamp |

**Constraints**: `UNIQUE(tenant_id, name)` — allows `(NULL, name)` as a global entry

**Seeded flags** (global defaults, all enabled by default):

| Flag | Default | Description |
|------|---------|-------------|
| `ai_search_enabled` | `1` | AI-powered normative search |
| `document_ingestion_enabled` | `1` | Corpus document ingestion pipeline |
| `hybrid_search_enabled` | `1` | FTS5 lexical component of hybrid search |
| `otp_auth_enabled` | `1` | Passwordless OTP email authentication |
| `portal_automation_enabled` | `0` | DGI/BPS Browser Rendering automation |

---

### `queries`

Persisted audit trail of every AI-answered consultation. Enables review of prior
criteria and complies with Art. 47 Código Tributario (secreto tributario).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `user_id` | TEXT | NOT NULL, FK → `users.id` | Querying user |
| `tenant_id` | TEXT | NOT NULL, FK → `tenants.id` | Tenant for multi-tenant reporting |
| `original_query` | TEXT | NOT NULL | Raw user query (before PII sanitization) |
| `sanitized_query` | TEXT | NOT NULL | Query after PII redaction |
| `response` | TEXT | NOT NULL | Full AI response |
| `latency_ms` | INTEGER | NOT NULL, DEFAULT `0` | End-to-end response time in milliseconds |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

**Indexes**:
- `idx_queries_user` on `(user_id, created_at DESC)`
- `idx_queries_tenant` on `(tenant_id, created_at DESC)`

---

### `documents`

Normative corpus documents. Only a 500-character preview is stored here;
full text lives in `document_chunks`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | Caller-provided identifier (e.g. `"decreto-123-2024"`) |
| `title` | TEXT | NOT NULL | Human-readable document title |
| `source` | TEXT | NOT NULL | Issuing authority (e.g. `"DGI"`, `"BPS"`) |
| `content` | TEXT | NOT NULL | First 500 characters (preview only) |
| `url` | TEXT | NULLABLE | Official URL for source citation |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

---

### `document_chunks`

Full document text split into ≤1 000-character paragraph chunks. Each chunk has a
contextual summary generated by an LLM at ingestion time.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | `{document_id}_chunk_{index}` |
| `document_id` | TEXT | NOT NULL, FK → `documents.id` (CASCADE DELETE) | Parent document |
| `chunk_text` | TEXT | NOT NULL | Raw chunk content |
| `context_summary` | TEXT | NULLABLE | 1–2 sentence AI-generated context summary |

---

### `document_chunks_fts` (FTS5 virtual table)

SQLite FTS5 virtual table powering the lexical component of hybrid search.
Automatically maintained by two triggers (`after_chunk_insert`, `after_chunk_delete`).

| Column | Description |
|--------|-------------|
| `chunk_id` | Matches `document_chunks.id` |
| `text_content` | `context_summary + " " + chunk_text` (concatenated for richer matching) |

**Tokenizer**: `unicode61` (handles Spanish accented characters)

---

### `companies`

Company profiles managed by each user/advisor.
One user may have multiple companies; each RUT must be unique per user.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `user_id` | TEXT | NOT NULL, FK → `users.id` (CASCADE) | Owner |
| `tenant_id` | TEXT | NOT NULL, FK → `tenants.id` (CASCADE) | Tenant |
| `rut` | TEXT | NOT NULL | 12-digit RUT (separators stripped) |
| `razon_social` | TEXT | NOT NULL | Legal company name |
| `nombre_comercial` | TEXT | NULLABLE | Trade name |
| `tipo_entidad` | TEXT | NOT NULL, DEFAULT `'srl'` | Entity type: `srl` · `sa` · `unipersonal` · `cooperativa` · `ong` · `sas` · `otro` |
| `regimen_irae` | TEXT | NOT NULL, DEFAULT `'real'` | Tax regime: `real` · `forfait` · `pequena_empresa` · `monotributo` · `exonerado` · `irnr` |
| `actividad` | TEXT | NULLABLE | Economic activity description |
| `bps_nro_patronal` | TEXT | NULLABLE | BPS employer registration number |
| `domicilio_fiscal` | TEXT | NULLABLE | Registered fiscal address |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |
| `updated_at` | INTEGER | DEFAULT now | Unix timestamp (updated on PUT) |

**Constraints**: `UNIQUE(user_id, rut)`
**Indexes**: `idx_companies_user` on `(user_id)`

---

### `tax_periods`

Monthly tax periods, each optionally linked to a company profile.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `user_id` | TEXT | NOT NULL, FK → `users.id` (CASCADE) | Owner |
| `tenant_id` | TEXT | NOT NULL, FK → `tenants.id` (CASCADE) | Tenant |
| `month` | INTEGER | NOT NULL, CHECK (1–12) | Calendar month |
| `year` | INTEGER | NOT NULL, CHECK (≥ 2000) | Calendar year |
| `label` | TEXT | NOT NULL | Human-readable label (e.g. `"Marzo 2025"`) |
| `status` | TEXT | NOT NULL, DEFAULT `'draft'` | `'draft'` or `'analyzed'` |
| `company_id` | TEXT | NULLABLE, FK → `companies.id` | Linked company (optional) |
| `notas` | TEXT | NULLABLE | Free-text notes for the period |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

**Constraints**: `UNIQUE(user_id, month, year)`
**Indexes**: `idx_tax_periods_user` on `(user_id, year DESC, month DESC)`

---

### `tax_documents`

Documents uploaded or imported for a given tax period.
Text content is stored inline for AI analysis; binary files are stored in R2 and referenced by `r2_key`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `period_id` | TEXT | NOT NULL, FK → `tax_periods.id` (CASCADE) | Owning period |
| `user_id` | TEXT | NOT NULL, FK → `users.id` (CASCADE) | Owner |
| `filename` | TEXT | NOT NULL | Original file name |
| `content` | TEXT | NOT NULL | Extracted text content (max 8 000 chars) |
| `doc_type` | TEXT | NULLABLE | User-supplied document type label |
| `r2_key` | TEXT | NULLABLE | R2 object key (set for uploaded files) |
| `mime_type` | TEXT | NULLABLE | MIME type of the uploaded file |
| `file_size` | INTEGER | NULLABLE | Size in bytes of the uploaded file |
| `source` | TEXT | NOT NULL, DEFAULT `'paste'` | Origin: `'paste'` · `'upload'` · `'gdoc'` |
| `source_url` | TEXT | NULLABLE | Original URL (for `gdoc` imports) |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

**R2 key format**: `tax/{userId}/{periodId}/{uuid}/{filename}`
**Indexes**: `idx_tax_docs_period` on `(period_id)`

---

### `tax_consolidations`

AI-generated tax analysis results. One row per period (replaced on re-consolidation).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `period_id` | TEXT | NOT NULL, UNIQUE, FK → `tax_periods.id` (CASCADE) | Analyzed period |
| `raw_response` | TEXT | NOT NULL | Raw JSON string from the LLM |
| `created_at` | INTEGER | DEFAULT now | Unix timestamp |

**Indexes**: `idx_tax_consol_period` on `(period_id)`

---

### `portal_sessions`

AES-256-GCM encrypted DGI/BPS portal session cookies, stored per company per portal.
One row per `(company_id, portal)` pair (unique constraint enforces upsert semantics).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID |
| `company_id` | TEXT | NOT NULL, FK → `companies.id` (CASCADE) | Company the session belongs to |
| `user_id` | TEXT | NOT NULL, FK → `users.id` (CASCADE) | Session owner |
| `portal` | TEXT | NOT NULL, CHECK (`'dgi'` \| `'bps'`) | Target portal |
| `encrypted_cookies` | TEXT | NOT NULL | Base64-encoded AES-256-GCM ciphertext of a JSON cookies array |
| `cookies_iv` | TEXT | NOT NULL | Base64-encoded 12-byte GCM IV |
| `session_established_at` | INTEGER | NOT NULL | Unix timestamp of successful login |
| `last_used_at` | INTEGER | NULLABLE | Unix timestamp of last task execution |
| `created_at` | INTEGER | NOT NULL, DEFAULT now | Unix timestamp |
| `updated_at` | INTEGER | NOT NULL, DEFAULT now | Unix timestamp |

**Constraints**: `UNIQUE(company_id, portal)`
**Indexes**: `idx_portal_sessions_user` on `(user_id, portal)`

---

## Entity-Relationship overview

```
tenants
  └── users (tenant_id)
        ├── sessions (user_id)
        ├── otp_codes (email — not FK)
        ├── terms_consents (user_id)
        ├── queries (user_id)
        ├── companies (user_id)
        │     └── portal_sessions (company_id)
        └── tax_periods (user_id)
              ├── tax_documents (period_id)
              └── tax_consolidations (period_id)

documents
  └── document_chunks (document_id)
        └── document_chunks_fts [virtual] (chunk_id trigger-synced)
```

---

## Running migrations

```bash
# Apply to local D1 (development)
npm run db:migrate:local

# Apply to remote D1 (production)
npm run db:migrate:remote
```
