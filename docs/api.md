# Adviser — REST API Reference

> **Base URL**: `https://<your-worker>.workers.dev` (production) or `http://localhost:8787` (local dev)

All `/api/*` endpoints are subject to **rate limiting**: 20 requests per IP per 60 seconds. Exceeding this limit returns `429 Too Many Requests`.

---

## Authentication

Protected endpoints require a session token in the `Authorization` header:

```
Authorization: Bearer <token>
```

Session tokens are issued by `POST /api/auth/verify-otp` and expire **24 hours** after creation.

---

## Terms & Conditions

### `GET /api/terms/version`

Returns the currently active Terms & Conditions version string.

**Response**

```json
{ "version": "1.0" }
```

Clients must pass this version back as `termsVersion` when calling `POST /api/auth/verify-otp`.

---

## Auth

### `POST /api/auth/request-otp`

Sends a 6-digit OTP code to the given email address. Any previous unused OTP for this email is invalidated first.

**Request body**

```json
{ "email": "user@example.com" }
```

**Responses**

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "message": "Código enviado. Revisá tu bandeja de entrada." }` |
| `400` | `{ "error": "Email inválido." }` |
| `502` | `{ "error": "No se pudo enviar el email…" }` |

---

### `POST /api/auth/verify-otp`

Verifies the OTP and issues a session token. On **first login**, a new tenant and user are created automatically.

**Request body**

```json
{
  "email": "user@example.com",
  "code": "123456",
  "termsVersion": "1.0"
}
```

> `termsVersion` must match the value returned by `GET /api/terms/version`; otherwise the request is rejected with `400`.

**Response `200`**

```json
{
  "ok": true,
  "sessionToken": "<uuid>",
  "isNewUser": false,
  "message": "Sesión iniciada correctamente."
}
```

| Status | Cause |
|--------|-------|
| `400` | Missing fields or wrong `termsVersion` |
| `401` | Invalid or expired OTP code |

---

### `POST /api/auth/logout`

Revokes the current session token (server-side deletion from D1).

**Headers**: `Authorization: ****** (optional — a missing token is silently ignored)

**Response `200`**

```json
{ "ok": true }
```

---

## User

### `GET /api/me` 🔒

Returns the authenticated user's profile information.

**Response `200`**

```json
{
  "userId": "<uuid>",
  "tenantId": "<uuid>",
  "email": "user@example.com",
  "role": "admin"
}
```

---

## Feature Flags

### `GET /api/feature-flags` 🔒

Returns the feature flag map for the authenticated user's tenant. Global flags serve as defaults; tenant-specific rows override them.

**Response `200`**

```json
{
  "flags": {
    "ai_search_enabled": true,
    "document_ingestion_enabled": true,
    "hybrid_search_enabled": true,
    "otp_auth_enabled": true,
    "portal_automation_enabled": false
  }
}
```

---

## RAG Corpus

### `GET /api/documents` 🔒

Lists all documents in the normative corpus with their chunk counts.

**Response `200`**

```json
{
  "documents": [
    {
      "id": "decreto-ley-14306",
      "title": "Código Tributario",
      "source": "DGI",
      "url": "https://www.impo.com.uy/...",
      "created_at": 1704067200,
      "chunk_count": 42
    }
  ]
}
```

---

### `POST /api/ingest` 🔒 👑

Ingests a new document into the RAG corpus. The document is:
1. Split into ≤1 000-char paragraph chunks.
2. Each chunk is contextualized by `llama-3-8b-instruct` (1–2 sentence summary).
3. Embedded via `bge-m3` and batch-upserted to Vectorize.
4. Stored in D1 with the contextual summaries.

**Requires**: `document_ingestion_enabled` feature flag = `true` and `admin` role.

**Request body**

```json
{
  "id": "decreto-123-2024",
  "title": "Decreto N° 123/024 — IVA",
  "source": "DGI",
  "content": "Texto completo del decreto…",
  "url": "https://www.impo.com.uy/…"
}
```

| Field | Required | Max length | Description |
|-------|----------|------------|-------------|
| `id` | ✅ | — | Unique document identifier (used as Vectorize vector prefix) |
| `title` | ✅ | — | Human-readable document title |
| `source` | ✅ | — | Issuing authority, e.g. `"DGI"`, `"BPS"`, `"Poder Ejecutivo"` |
| `content` | ✅ | 20 000 chars | Full document text |
| `url` | ❌ | — | Official URL for source citation |

**Responses**

| Status | Body |
|--------|------|
| `200` | `{ "success": true, "message": "Documento '...' ingestado y contextualizado exitosamente." }` |
| `400` | Missing required fields |
| `409` | Duplicate `id` |
| `413` | Content exceeds 20 000 character limit |
| `503` | `document_ingestion_enabled` flag is `false` |

---

### `DELETE /api/documents/:id` 🔒 👑

Removes a document and all its chunks from D1 and Vectorize.

**Responses**

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "message": "Documento '...' eliminado del corpus." }` |
| `404` | Document not found |

---

## AI Search

### `GET /api/search?q=<query>` 🔒

Executes the full RAG pipeline against the normative corpus:
1. PII sanitization (RUT, CI, amounts redacted).
2. Hybrid retrieval: semantic (Vectorize) + lexical (FTS5) — FTS5 can be disabled via `hybrid_search_enabled` flag.
3. LLM generation with `@cf/qwen/qwq-32b` using the retrieved context.
4. Response + latency persisted to query history (non-blocking).

**Requires**: `ai_search_enabled` feature flag = `true`.

**Query parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `q` | ✅ | Natural-language question in Spanish |

**Response `200`**

```json
{
  "originalQuery": "¿Cuál es la tasa de IVA en Uruguay?",
  "sanitizedQuery": "¿Cuál es la tasa de IVA en Uruguay?",
  "response": "La tasa básica del IVA en Uruguay es del 22%… [Origen: DGI | Documento: …]",
  "latencyMs": 1234
}
```

| Status | Cause |
|--------|-------|
| `400` | Missing `q` parameter |
| `503` | `ai_search_enabled` flag is `false` |

---

## Query History

### `GET /api/history` 🔒

Returns paginated query history for the authenticated user.

**Query parameters**

| Param | Default | Max | Description |
|-------|---------|-----|-------------|
| `page` | `1` | — | Page number (1-based) |
| `limit` | `20` | `50` | Items per page |

**Response `200`**

```json
{
  "queries": [
    {
      "id": "<uuid>",
      "originalQuery": "¿Cuál es la tasa de IRAE?",
      "sanitizedQuery": "¿Cuál es la tasa de IRAE?",
      "response": "La tasa de IRAE es del 25%...",
      "latencyMs": 980,
      "createdAt": 1704067200
    }
  ],
  "page": 1,
  "limit": 20,
  "hasMore": false
}
```

---

## Company Profiles

### `GET /api/companies` 🔒

Lists all company profiles belonging to the authenticated user, ordered alphabetically by `razon_social`.

**Response `200`**

```json
{
  "companies": [
    {
      "id": "<uuid>",
      "rut": "210000010018",
      "razon_social": "Empresa Ejemplo SRL",
      "nombre_comercial": "Ejemplo",
      "tipo_entidad": "srl",
      "regimen_irae": "real",
      "actividad": "Servicios de consultoría",
      "bps_nro_patronal": "123456",
      "domicilio_fiscal": "Av. 18 de Julio 1234, Montevideo",
      "created_at": 1704067200
    }
  ]
}
```

---

### `POST /api/companies` 🔒

Creates a new company profile.

**Request body**

```json
{
  "rut": "210000010018",
  "razon_social": "Empresa Ejemplo SRL",
  "nombre_comercial": "Ejemplo",
  "tipo_entidad": "srl",
  "regimen_irae": "real",
  "actividad": "Servicios de consultoría",
  "bps_nro_patronal": "123456",
  "domicilio_fiscal": "Av. 18 de Julio 1234, Montevideo"
}
```

| Field | Required | Values / Notes |
|-------|----------|----------------|
| `rut` | ✅ | 12 digits, separators stripped automatically |
| `razon_social` | ✅ | Legal company name |
| `nombre_comercial` | ❌ | Trade name |
| `tipo_entidad` | ❌ | `srl` · `sa` · `unipersonal` · `cooperativa` · `ong` · `sas` · `otro` (default: `srl`) |
| `regimen_irae` | ❌ | `real` · `forfait` · `pequena_empresa` · `monotributo` · `exonerado` · `irnr` (default: `real`) |
| `actividad` | ❌ | Economic activity description |
| `bps_nro_patronal` | ❌ | BPS employer registration number |
| `domicilio_fiscal` | ❌ | Registered fiscal address |

**Responses**

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "company": { … } }` |
| `400` | Missing `rut` or `razon_social`, or invalid RUT format |
| `409` | Duplicate RUT for this user |

---

### `PUT /api/companies/:id` 🔒

Updates an existing company profile (all fields except `rut` and `id`).

**Request body**: same shape as `POST /api/companies` (excluding `rut`).

**Responses**

| Status | Body |
|--------|------|
| `200` | `{ "ok": true }` |
| `400` | Missing `razon_social` |
| `404` | Company not found or not owned by the authenticated user |

---

### `DELETE /api/companies/:id` 🔒

Deletes a company profile. Cascades to linked tax periods and portal sessions.

**Responses**

| Status | Body |
|--------|------|
| `200` | `{ "ok": true }` |
| `404` | Company not found |

---

## Tax Analysis

### `GET /api/tax/periods` 🔒

Lists all tax periods for the authenticated user, ordered by year and month descending.

**Response `200`**

```json
{
  "periods": [
    {
      "id": "<uuid>",
      "month": 3,
      "year": 2025,
      "label": "Marzo 2025",
      "status": "analyzed",
      "created_at": 1741046400,
      "company_id": "<uuid>",
      "company_name": "Empresa Ejemplo SRL",
      "doc_count": 3
    }
  ]
}
```

---

### `POST /api/tax/periods` 🔒

Creates a new tax period (month + year, optionally linked to a company).

**Request body**

```json
{
  "month": 3,
  "year": 2025,
  "company_id": "<uuid>",
  "notas": "Período con vencimientos anticipados por CEDE."
}
```

**Responses**

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "period": { … } }` |
| `400` | Invalid month/year |
| `404` | `company_id` not found or not owned by user |
| `409` | Duplicate period for the same month/year (per user) |

---

### `DELETE /api/tax/periods/:id` 🔒

Deletes a tax period and all its documents and consolidation results.

---

### `GET /api/tax/periods/:id/documents` 🔒

Returns the period metadata (including linked company profile) and the list of uploaded documents.

**Response `200`**

```json
{
  "period": {
    "id": "<uuid>",
    "label": "Marzo 2025",
    "status": "draft",
    "company_id": "<uuid>",
    "notas": null,
    "company_rut": "210000010018",
    "company_name": "Empresa Ejemplo SRL",
    "tipo_entidad": "srl",
    "regimen_irae": "real",
    "actividad": "Consultoría",
    "bps_nro_patronal": "123456"
  },
  "documents": [
    {
      "id": "<uuid>",
      "filename": "libro-iva-marzo.csv",
      "doc_type": "Libro IVA",
      "created_at": 1741046400,
      "content_length": 3420,
      "has_file": 1,
      "source": "upload"
    }
  ]
}
```

---

### `POST /api/tax/periods/:id/documents` 🔒

Adds a tax document by pasting its text content. Limit: **10 documents per period**, **8 000 characters per document**.

**Request body**

```json
{
  "filename": "libro-iva-marzo.txt",
  "content": "Texto del documento...",
  "doc_type": "Libro IVA"
}
```

**Responses**

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "document": { … } }` |
| `400` | Missing `filename` or `content` |
| `413` | Content exceeds 8 000 characters |
| `422` | Period has reached the 10-document limit |

---

### `POST /api/tax/periods/:id/upload` 🔒

Uploads a file (multipart form) to R2 and registers it as a tax document.
Text-like files (`.txt`, `.csv`, `.json`, `.xml`, etc.) have their text extracted for AI analysis.
Binary files (PDFs, images) are stored in R2 but the `content` field will be empty.

**Form fields**

| Field | Required | Description |
|-------|----------|-------------|
| `file` | ✅ | File (max 10 MB) |
| `doc_type` | ❌ | Document type label, e.g. `"Libro IVA"` |

**Response `201`**

```json
{
  "ok": true,
  "document": {
    "id": "<uuid>",
    "filename": "libro-iva-marzo.csv",
    "doc_type": "Libro IVA",
    "content_length": 3420,
    "mime_type": "text/csv",
    "file_size": 3420,
    "has_file": true,
    "text_extracted": true
  }
}
```

---

### `POST /api/tax/periods/:id/import-gdoc` 🔒

Imports text from a public Google Docs or Google Sheets URL by fetching its plain-text export.

**Request body**

```json
{
  "url": "https://docs.google.com/document/d/<doc-id>/edit",
  "doc_type": "Balance general",
  "filename": "balance-marzo-2025.txt"
}
```

> The document must be shared as "Anyone with the link can view."

**Responses**

| Status | Body |
|--------|------|
| `201` | `{ "ok": true, "document": { … } }` |
| `400` | Missing URL or unrecognized URL format (only Google Docs/Sheets accepted) |
| `422` | Document is empty or inaccessible |
| `502` | Failed to connect to Google |

---

### `DELETE /api/tax/periods/:id/documents/:docId` 🔒

Deletes a tax document from D1. If the document has an associated R2 file, it is also deleted asynchronously.

---

### `GET /api/tax/periods/:id/documents/:docId/download` 🔒

Serves the original uploaded file from R2 as an attachment download.

Returns `404` if the document was created by paste (`source: 'paste'`) or import (`source: 'gdoc'`) and has no associated R2 file.

---

### `POST /api/tax/periods/:id/consolidate` 🔒

Runs the AI tax consolidation analysis over all documents in the period.
Uses `@cf/qwen/qwq-32b` with a detailed prompt embedding current Uruguayan tax law (IVA, IRAE, IRPF, IRNR, IP, BPS, Monotributo).

**Requires**: `ai_search_enabled` feature flag = `true`. The period must have at least one document.

**Response `200`**

```json
{
  "ok": true,
  "response": "{\"periodo\":\"Marzo 2025\",\"resumen\":\"...\",\"impuestos\":[…],\"alertas\":[…],\"recomendaciones\":[…],\"total_a_pagar\":12345.67}"
}
```

The `response` field is a **JSON string** with the following schema:

```json
{
  "periodo": "Marzo 2025",
  "resumen": "Descripción profesional de la situación impositiva global.",
  "impuestos": [
    {
      "tipo": "IVA — Formulario FF",
      "base_imponible": 100000,
      "tasa": 22,
      "monto_estimado": 22000,
      "vencimiento": "25/04/2025",
      "estado": "a_pagar",
      "notas": "Vence el 25 por dígito RUT 5."
    }
  ],
  "alertas": ["Vencimiento IRAE anticipo en 3 días."],
  "recomendaciones": ["Verificar crédito fiscal IVA antes del vencimiento."],
  "total_a_pagar": 22000
}
```

**`estado` values**: `"a_pagar"` · `"retencion"` · `"a_cobrar"` · `"informativo"`

---

### `GET /api/tax/periods/:id/consolidation` 🔒

Fetches the most recent consolidation result for a period without re-running the AI.

**Response `200`** (if analyzed)

```json
{
  "analyzed": true,
  "raw_response": "{…}",
  "created_at": 1741046400
}
```

Returns `{ "analyzed": false }` if no consolidation has been run yet.

---

## Portal Automation (DGI / BPS)

> **Requires**: `portal_automation_enabled` feature flag = `true`, `BROWSER` binding, and `PORTAL_ENCRYPTION_KEY` secret.
> Portal automation uses Cloudflare Browser Rendering (Puppeteer) and requires a paid Cloudflare plan.

Session cookies captured at login are encrypted with **AES-256-GCM** before storage in D1. They are decrypted in memory only when a task is executed.

---

### `POST /api/portal/:portal/connect` 🔒

Logs in to a government portal with the provided credentials, captures the session cookies, encrypts them, and stores them in D1.

`:portal` must be `"dgi"` or `"bps"`.

**Request body**

```json
{
  "company_id": "<uuid>",
  "username": "210000010018",
  "password": "secret"
}
```

**Responses**

| Status | Body |
|--------|------|
| `200` | `{ "ok": true, "message": "Sesión DGI establecida correctamente." }` |
| `400` | Invalid portal name or missing fields |
| `404` | `company_id` not found |
| `422` | Login failed (invalid credentials, CAPTCHA detected, or portal unavailable) |
| `503` | Feature flag disabled, `BROWSER` not configured, or encryption key missing |

---

### `GET /api/portal/:portal/status?company_id=<id>` 🔒

Returns whether a stored session exists for a given company + portal combination.

**Response `200`**

```json
{ "connected": true }
```

---

### `POST /api/portal/:portal/task` 🔒

Restores the stored session and executes an automated task on the portal.

**Request body**

```json
{
  "company_id": "<uuid>",
  "task": "consulta_estado_cuenta",
  "params": {}
}
```

| `task` value | Description |
|---|---|
| `consulta_estado_cuenta` | Retrieves the tax account balance/status |
| `descarga_constancia` | Downloads the fiscal standing certificate |
| `consulta_deuda` | Retrieves outstanding debt details |

**Response `200`**

```json
{
  "ok": true,
  "task": "consulta_estado_cuenta",
  "data": { "raw_text": "Estado de cuenta DGI…" }
}
```

Returns `{ "expired": true, "error": "…" }` with status `401` if the session has expired.

---

### `DELETE /api/portal/:portal/disconnect` 🔒

Removes the stored portal session for a company, requiring re-authentication for future tasks.

**Request body**

```json
{ "company_id": "<uuid>" }
```

**Response `200`**: `{ "ok": true }`

---

## Icon Legend

| Icon | Meaning |
|------|---------|
| 🔒 | Requires `Authorization: ****** |
| 👑 | Requires `admin` role |
