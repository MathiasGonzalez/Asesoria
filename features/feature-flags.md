# Feature Flags

## Overview

Feature flags are stored in the D1 `feature_flags` table and evaluated per-tenant at request time. A global row (`tenant_id IS NULL`) provides the default; a tenant-specific row overrides it.

## Default Flags

| Flag name | Default | Description |
|---|---|---|
| `ai_search_enabled` | `true` | Enables the `/api/search` AI endpoint |
| `document_ingestion_enabled` | `true` | Enables the `/api/ingest` endpoint |
| `hybrid_search_enabled` | `true` | Uses Vectorize + FTS5 fusion in RAG |
| `otp_auth_enabled` | `true` | Enforces OTP authentication on all routes |

## API

### `GET /api/feature-flags`

Returns all flags resolved for the authenticated tenant.

**Headers:** `Authorization: <session-token>` (session token from /api/auth/verify-otp)

**Response:**
```json
{ "flags": { "ai_search_enabled": true, "document_ingestion_enabled": true, ... } }
```

## Managing Flags via D1

```sh
# Disable AI search globally
wrangler d1 execute advisor_uy_db --remote \
  --command "INSERT INTO feature_flags (tenant_id, name, enabled) VALUES (NULL, 'ai_search_enabled', 0) ON CONFLICT(tenant_id, name) DO UPDATE SET enabled=0"

# Override for a specific tenant
wrangler d1 execute advisor_uy_db --remote \
  --command "INSERT INTO feature_flags (tenant_id, name, enabled) VALUES ('<tenant-uuid>', 'document_ingestion_enabled', 0) ON CONFLICT(tenant_id, name) DO UPDATE SET enabled=0"
```

## Schema

```sql
CREATE TABLE feature_flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT,          -- NULL = global default
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  metadata   TEXT,          -- JSON
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(tenant_id, name)
);
```

## Checklist de implementación

### Base de datos
- [x] Tabla `feature_flags` creada con `UNIQUE(tenant_id, name)`
- [x] Fila global (`tenant_id IS NULL`) con flags por defecto: `ai_search_enabled`, `document_ingestion_enabled`, `hybrid_search_enabled`, `otp_auth_enabled`
- [x] Migración aplicada en local y remoto

### Backend
- [x] `GET /api/feature-flags` — devuelve todos los flags resueltos para el tenant autenticado
- [x] Lógica de resolución: fila tenant-específica sobreescribe la global
- [x] Middleware consume flags para proteger endpoints sensibles (ej: `ai_search_enabled`)

### Validación
- [x] Flag global `false` bloquea el endpoint para todos los tenants
- [x] Override tenant-específico sobreescribe el global correctamente
- [x] Flag inexistente para un tenant hereda el valor global por defecto
- [x] Entornos `prod` y `develop` tienen flags independientes
