# Tech Spec: Tax Situation Analysis

## Stack

Worker Hono + D1 + R2 + Workers AI. Para la exportación del consolidado como PDF se usa el **FluentReport Container** (Cloudflare Containers, .NET 10).

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `tax_periods`, `tax_documents`, `tax_consolidations` |
| `DOCUMENTS_BUCKET` | R2 | Archivos originales de los documentos del período |
| `AI` | Workers AI | `qwq-32b` para consolidación IA |
| `REPORT_CONTAINER` | Container DO | FluentReport API para exportar consolidado como PDF |

## FluentReport Container — exportación PDF

La exportación del consolidado (`GET /api/tax/periods/:id/consolidation/pdf`) llama al Container de FluentReport:

```typescript
// src/services/reports.ts
export async function renderConsolidationPdf(
  env: Env,
  consolidation: TaxConsolidation,
  company: Company
): Promise<Uint8Array> {
  const container = getContainer(env.REPORT_CONTAINER, 'default')
  const res = await container.fetch('http://internal/render/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildConsolidationSchema(consolidation, company))
  })
  return new Uint8Array(await res.arrayBuffer())
}
```

El schema JSON enviado al Container sigue el formato de **FluentReport.Schema** (ver [repo FluentReport](https://github.com/MathiasGonzalez/FluentReport)).

### Binding en `wrangler.jsonc`

```jsonc
[[durable_objects.bindings]]
name       = "REPORT_CONTAINER"
class_name = "FluentReportContainer"

[containers]
image        = "ghcr.io/mathiasgonzalez/fluentreport-api:latest"
max_instances = 2
```

> Ver `features/fluentreport-container.tech.md` para la configuración completa del Container compartido.

## Estructura de archivos

```
src/
├── routes/tax.ts                    # Todos los endpoints /api/tax/*
├── services/tax-consolidation.ts    # Lógica de consolidación IA
└── services/reports.ts              # Integración FluentReport Container
```

## Esquema D1

Migración: `migrations/0005_tax.sql`

```sql
CREATE TABLE tax_periods (id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT,
  month INTEGER, year INTEGER, label TEXT, status TEXT, company_id TEXT, notas TEXT,
  created_at INTEGER, UNIQUE(user_id, month, year, company_id));

CREATE TABLE tax_documents (id TEXT PRIMARY KEY, period_id TEXT, user_id TEXT,
  filename TEXT, content TEXT, doc_type TEXT, r2_key TEXT, mime_type TEXT,
  file_size INTEGER, source TEXT DEFAULT 'paste', source_url TEXT, created_at INTEGER);

CREATE TABLE tax_consolidations (id TEXT PRIMARY KEY, period_id TEXT UNIQUE,
  raw_response TEXT, created_at INTEGER);
```

## Feature flag

`ai_search_enabled` — si está deshabilitado, el endpoint `/consolidate` devuelve `403`.
