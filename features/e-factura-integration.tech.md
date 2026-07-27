# Tech Spec: Integración e-Factura / CFE

## Stack

Worker Hono + D1 + **UruFactura Container** ([MathiasGonzalez/UruFactura](https://github.com/MathiasGonzalez/UruFactura)) — Cloudflare Containers (.NET 10). El Worker actúa como proxy multi-tenant hacia el Container.

## Arquitectura

```
Adviser Worker (TypeScript/Hono)
  └─→ UruFactura Container (Durable Object por empresa)
        └─→ DGI SOAP endpoint (internet)
```

El Container del UruFactura corre el proceso .NET (`UruFactura.CloudflareApi`) que maneja la firma digital XAdES-BES, la comunicación SOAP con DGI y la generación de PDF del CFE (usando FluentReport internamente).

Cada empresa (`company_id`) obtiene **su propio Durable Object / instancia de Container** via `X-Tenant-Id`, garantizando aislamiento total de CAEs, certificados y series numéricas.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `cfe_configs`, `cfe_documents`, `cfe_caes` |
| `DOCUMENTS_BUCKET` | R2 | Almacena XML y PDF de CFEs emitidos |
| `URUFACTURA_CONTAINER` | Container DO | UruFactura .NET API |

```jsonc
// wrangler.jsonc — agregar:
[[durable_objects.bindings]]
name       = "URUFACTURA_CONTAINER"
class_name = "UruFacturaContainer"

[[migrations]]
tag         = "v2"
new_classes = ["UruFacturaContainer"]

[containers]
image        = "ghcr.io/mathiasgonzalez/urufacturasdk-api:latest"
max_instances = 20   // un container por empresa activa simultáneamente
```

### Secrets por empresa (Worker Secrets)

Los certificados digitales DGI se almacenan como secretos en el Worker, **nunca en D1 en texto plano**:

| Secret | Descripción |
|--------|-------------|
| `CFE_CERT_{COMPANY_ID}` | Certificado `.p12` en Base64 por empresa |
| `CFE_CERT_PWD_{COMPANY_ID}` | Password del certificado por empresa |

> En una implementación multi-tenant escalable, los secretos se guardan en **Cloudflare KV** cifrados con una clave maestra (Workers Secret), no como secretos individuales del Worker.

## Estructura de archivos

```
src/
├── routes/cfe.ts              # Todos los endpoints /api/cfe/*
├── services/urufactura.ts     # Proxy hacia UruFactura Container
└── services/cfe-store.ts      # Persistencia en D1 + R2 de CFEs emitidos
```

## Proxy hacia el Container (`src/services/urufactura.ts`)

```typescript
import { getContainer } from 'cloudflare:containers'

export async function emitCfe(env: Env, companyId: string, cfePayload: CfeRequest): Promise<CfeResponse> {
  // Cada empresa tiene su propio container (instancia Durable Object)
  const container = getContainer(env.URUFACTURA_CONTAINER, companyId)
  const res = await container.fetch('http://internal/api/cfe/emit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cert-Base64':  await getCompanyCert(env, companyId),
      'X-Cert-Password': await getCompanyCertPwd(env, companyId),
    },
    body: JSON.stringify(cfePayload)
  })
  return res.json<CfeResponse>()
}
```

El Container espera el mismo formato JSON que define la API `UruFactura.CloudflareApi` (ver [docs/ARQUITECTURA_CLOUDFLARE.md en UruFactura](https://github.com/MathiasGonzalez/UruFactura/blob/main/docs/ARQUITECTURA_CLOUDFLARE.md)).

## Esquema D1

Migración: `migrations/0014_cfe.sql`

```sql
CREATE TABLE cfe_configs (
  id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, company_id TEXT UNIQUE,
  rut_emisor TEXT, razon_social TEXT,
  serie_inicio INTEGER DEFAULT 1,
  ambiente TEXT DEFAULT 'homologacion',  -- homologacion | produccion
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE cfe_caes (
  id TEXT PRIMARY KEY, company_id TEXT,
  nro_serie TEXT, tipo_cfe INTEGER,
  rango_desde INTEGER, rango_hasta INTEGER,
  ultimo_nro_usado INTEGER DEFAULT 0,
  fecha_vencimiento TEXT,
  created_at INTEGER,
  UNIQUE(company_id, nro_serie)
);

CREATE TABLE cfe_documents (
  id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, company_id TEXT,
  tipo_cfe INTEGER, numero INTEGER, serie TEXT,
  fecha_emision TEXT, rut_receptor TEXT, razon_receptor TEXT,
  subtotal REAL, iva_tasa TEXT, monto_iva REAL, total REAL,
  estado TEXT DEFAULT 'borrador',
  cfe_xml_r2_key TEXT,    -- XML firmado en R2
  cfe_pdf_r2_key TEXT,    -- PDF representación impresa en R2
  cae_numero TEXT,
  periodo_id TEXT,         -- FK a tax_periods (libro IVA automático)
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_cfe_company_period ON cfe_documents(company_id, fecha_emision);
```

## Persistencia de CAEs

El Container UruFactura usa `InMemoryCaeRepository` por defecto, lo que significa que los CAEs se pierden si el container se duerme (después de 5 min de inactividad). Para producción, el Worker debe:

1. Cargar los CAEs desde `cfe_caes` en D1 al iniciar cada request.
2. Enviarlos al Container en el header `X-Caes-Json` antes de emitir.
3. Actualizar `ultimo_nro_usado` en D1 después de cada emisión exitosa.

```typescript
// services/urufactura.ts — antes de emitir
const caes = await env.DB.prepare(
  'SELECT * FROM cfe_caes WHERE company_id = ?'
).bind(companyId).all()

// POST al container con los CAEs serializados
headers['X-Caes-Json'] = JSON.stringify(caes.results)
```

## Tipos de CFE soportados

Todos los tipos soportados por UruFactura v25.2:

| Código | Tipo | Método API |
|--------|------|-----------|
| 101 | e-Ticket | `POST /api/cfe/emit` con `tipo: 101` |
| 111 | e-Factura | `POST /api/cfe/emit` con `tipo: 111` |
| 121 | e-Factura Exportación | `POST /api/cfe/emit` con `tipo: 121` |
| 181 | e-Remito | `POST /api/cfe/emit` con `tipo: 181` |
| 151 | e-Resguardo | `POST /api/cfe/emit` con `tipo: 151` |
| 102/112 | Notas de Crédito | `POST /api/cfe/emit` con `tipo: 102\|112` |

## Despliegue del Container

El Container de UruFactura se despliega **independientemente** del Worker de Adviser, desde el repo [MathiasGonzalez/UruFactura](https://github.com/MathiasGonzalez/UruFactura):

```bash
# Desde el repo UruFactura
cd cloudflare
wrangler deploy
```

El Worker de Adviser solo necesita el binding `URUFACTURA_CONTAINER` apuntando al Durable Object class `UruFacturaContainer`.

## Integración con Tax Analysis

Al cerrar el mes, el endpoint `POST /api/cfe/generate-iva-book` agrega automáticamente los libros IVA ventas y compras como documentos del período fiscal (`tax_documents`) para que el análisis IA los incluya.

## Feature flag

`cfe_enabled` — protege todos los endpoints `/api/cfe/*` y la generación automática de libros IVA.

## Checklist de implementación técnica

- [ ] UruFactura Container desplegado (ver repositorio `MathiasGonzalez/UruFactura`)
- [ ] Tablas `cfe_configs`, `cfe_documents` creadas con índices
- [ ] `cfe_configs.certificado_b64` cifrado con AES-256-GCM antes de persistir
- [ ] `src/routes/cfe.ts` creado con todos los endpoints
- [ ] Binding `URUFACTURA_CONTAINER` (Durable Object) en `wrangler.jsonc`
- [ ] Binding `REPORT_CONTAINER` (FluentReport) en `wrangler.jsonc` para generación de PDF de CFE
- [ ] Feature flag `cfe_enabled` creado y protegiendo todos los endpoints
