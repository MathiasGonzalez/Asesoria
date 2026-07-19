# Tech Spec: Feature Flags

## Stack

Worker Hono + D1. Sin bindings adicionales.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tabla `feature_flags` |

## Estructura de archivos

```
src/
├── routes/feature-flags.ts    # GET /api/feature-flags
└── services/flags.ts          # getFlag(env, tenantId, name): boolean
```

## Esquema D1

Migración: `migrations/0003_flags.sql`

```sql
CREATE TABLE feature_flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT,        -- NULL = default global
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  metadata   TEXT,
  updated_at INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(tenant_id, name)
);
-- Defaults
INSERT INTO feature_flags (tenant_id, name, enabled) VALUES
  (NULL, 'ai_search_enabled', 1),
  (NULL, 'document_ingestion_enabled', 1),
  (NULL, 'hybrid_search_enabled', 1),
  (NULL, 'otp_auth_enabled', 1);
```

## Resolución de flags

```typescript
// Primero busca override del tenant; si no existe, usa el global
const row = await env.DB.prepare(
  `SELECT enabled FROM feature_flags
   WHERE (tenant_id = ? OR tenant_id IS NULL) AND name = ?
   ORDER BY tenant_id IS NULL ASC LIMIT 1`
).bind(tenantId, flagName).first()
```

## Flags estándar del sistema

| Flag | Default | Protege |
|------|---------|---------|
| `ai_search_enabled` | `true` | `GET /api/search` |
| `document_ingestion_enabled` | `true` | `POST /api/ingest` |
| `hybrid_search_enabled` | `true` | Vectorize + FTS5 en RAG |
| `otp_auth_enabled` | `true` | Middleware de sesión |

Al agregar nuevas features, se agrega un flag correspondiente en la migración inicial de esa feature.
