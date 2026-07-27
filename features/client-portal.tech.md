# Tech Spec: Portal del Cliente

## Stack

Worker Hono + D1 + R2 + **FluentReport Container** (Cloudflare Containers, .NET 10) para generación de informes PDF compartibles.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `client_invitations`, `document_requests`, `document_request_items`, `client_approvals` |
| `DOCUMENTS_BUCKET` | R2 | Almacena los informes PDF generados para links de descarga |
| `REPORT_CONTAINER` | Container DO | FluentReport API para generar informes PDF |
| `EMAIL_SEND` | Send Email | Invitaciones y notificaciones al cliente |

## FluentReport Container — informes PDF

Cuando el contador comparte un informe (`POST /api/portal/share`), el Worker:

1. Llama al Container de FluentReport con el JSON del informe.
2. Recibe los bytes del PDF.
3. Los guarda en R2 con clave `portal/{tenantId}/{companyId}/{token}.pdf`.
4. Devuelve un link firmado con TTL de 72 horas.

```typescript
// src/services/reports.ts
export async function renderClientReport(env: Env, data: ReportData): Promise<string> {
  const container = getContainer(env.REPORT_CONTAINER, 'default')
  const res = await container.fetch('http://internal/render/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildClientReportSchema(data))
  })
  const pdfBytes = new Uint8Array(await res.arrayBuffer())
  const key = `portal/${data.tenantId}/${data.companyId}/${crypto.randomUUID()}.pdf`
  await env.DOCUMENTS_BUCKET.put(key, pdfBytes, { httpMetadata: { contentType: 'application/pdf' } })
  return key
}
```

> Ver `features/fluentreport-container.tech.md` para la configuración completa del Container compartido.

## Estructura de archivos

```
src/
├── routes/portal.ts           # Todos los endpoints /api/portal/*
└── services/reports.ts        # Integración FluentReport Container (compartida con otros módulos)
```

## Esquema D1

Migración: `migrations/0011_portal.sql`

```sql
CREATE TABLE client_invitations (
  id TEXT PRIMARY KEY, tenant_id TEXT, company_id TEXT, email TEXT,
  token TEXT UNIQUE, status TEXT DEFAULT 'pending',
  invited_by TEXT, created_at INTEGER, expires_at INTEGER
);

CREATE TABLE document_requests (
  id TEXT PRIMARY KEY, tenant_id TEXT, company_id TEXT, created_by TEXT,
  title TEXT, description TEXT, due_date TEXT, status TEXT DEFAULT 'open',
  created_at INTEGER
);

CREATE TABLE document_request_items (
  id TEXT PRIMARY KEY, request_id TEXT, label TEXT, doc_type TEXT,
  required INTEGER DEFAULT 1, fulfilled INTEGER DEFAULT 0,
  document_id TEXT, fulfilled_at INTEGER
);

CREATE TABLE client_approvals (
  id TEXT PRIMARY KEY, tenant_id TEXT, company_id TEXT, period_id TEXT,
  approved_by TEXT, approved_at INTEGER, ip_address TEXT,
  document_hash TEXT, notes TEXT
);
```

## Seguridad de links de descarga

Los links de descarga usan tokens UUID guardados en D1 con `expires_at`. El endpoint `GET /api/portal/share/:token` verifica la expiración antes de generar la URL firmada de R2:

```typescript
const presigned = await env.DOCUMENTS_BUCKET.createSignedUrl(r2Key, { expiresIn: 3600 })
```

## Feature flag

`client_portal_enabled` — protege todos los endpoints `/api/portal/*`.

## Checklist de implementación técnica

- [ ] Tablas `client_invitations`, `document_requests`, `document_request_items`, `client_approvals` creadas
- [ ] `src/routes/portal.ts` creado con todos los endpoints de portal
- [ ] Link de descarga firmado con TTL implementado (token de tiempo limitado en KV o firmado)
- [ ] Hash SHA-256 del documento aprobado calculado y almacenado en `client_approvals.document_hash`
- [ ] Worker Secret o KV para tokens de link temporal configurado
