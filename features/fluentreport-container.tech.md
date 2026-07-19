# Tech Spec: FluentReport Container (Compartido)

Especificación técnica del **Cloudflare Container de FluentReport** ([MathiasGonzalez/FluentReport](https://github.com/MathiasGonzalez/FluentReport)) utilizado por múltiples features de Adviser para generación de documentos PDF, Excel y HTML.

## Dependencias de esta tech spec

Este Container es utilizado por:

| Feature | Documento generado |
|---------|--------------------|
| `tax-analysis` | Exportación del consolidado fiscal |
| `payroll-processing` | Recibo de sueldo (PDF A4) |
| `client-portal` | Informes compartidos con clientes |
| `bank-reconciliation` | Reporte de conciliación PDF |

## Arquitectura

```
Adviser Worker (TypeScript/Hono)
  └─→ FluentReport Container (Durable Object "default")
        └─→ Renderiza PDF/Excel/HTML (SkiaSharp + ClosedXML, .NET 10)
              └─→ Devuelve bytes al Worker
                    └─→ Worker sirve o guarda en R2
```

El Container usa una **sola instancia compartida** (`"default"`) porque la generación de reportes es stateless: recibe un schema JSON y devuelve bytes.

## Bindings en `wrangler.jsonc`

```jsonc
// Agregar al wrangler.jsonc de Adviser:

[[durable_objects.bindings]]
name       = "REPORT_CONTAINER"
class_name = "FluentReportContainer"

[[migrations]]
tag         = "v3"
new_classes = ["FluentReportContainer"]

// En la sección [containers] (puede coexistir con UruFactura):
// Nota: Cloudflare permite múltiples containers en el mismo Worker.
// Cada [containers] block define una imagen diferente.
```

> En Cloudflare Containers, si un Worker necesita múltiples imágenes, se definen múltiples `[[durable_objects.bindings]]` con distintos `class_name`. El Worker JS exporta ambas clases.

## Worker export (agregar a `src/index.ts` o archivo dedicado)

```typescript
// src/containers.ts
import { Container, getContainer } from 'cloudflare:containers'

export class FluentReportContainer extends Container {
  defaultPort = 8080
  sleepAfter  = '5m'
}

// Helper compartido para todas las features
export async function renderPdf(env: Env, schema: object): Promise<Uint8Array> {
  const container = getContainer(env.REPORT_CONTAINER, 'default')
  const res = await container.fetch('http://internal/render/pdf', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(schema),
  })
  if (!res.ok) throw new Error(`FluentReport error: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function renderExcel(env: Env, schema: object): Promise<Uint8Array> {
  const container = getContainer(env.REPORT_CONTAINER, 'default')
  const res = await container.fetch('http://internal/render/excel', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(schema),
  })
  if (!res.ok) throw new Error(`FluentReport error: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
```

## Imagen Docker del Container

El Container de FluentReport necesita una API .NET 10 mínima que exponga los endpoints de renderizado. Dado que FluentReport es una librería (no una API lista para deployar), se construye una API wrapper:

```
# Repositorio: MathiasGonzalez/FluentReport
# Dockerfile del API wrapper (por construir en ese repo)
# Expone:
#   POST /render/pdf    → recibe JSON schema → devuelve application/pdf
#   POST /render/excel  → recibe JSON schema → devuelve application/vnd.openxmlformats...
#   POST /render/html   → recibe JSON schema → devuelve text/html
```

La imagen se publica en `ghcr.io/mathiasgonzalez/fluentreport-api:latest`.

## Format del schema (FluentReport.Schema)

El Worker construye el schema JSON siguiendo el formato de **FluentReport.Schema**. Referencia normativa: [`docs/schema/report-schema.md`](https://github.com/MathiasGonzalez/FluentReport/blob/main/docs/schema/report-schema.md).

Ejemplo mínimo para un recibo de sueldo:

```json
{
  "page": {
    "size": "A4",
    "marginAll": 40
  },
  "header": {
    "text": "RECIBO DE SUELDO",
    "fontSize": 16,
    "bold": true,
    "alignCenter": true
  },
  "content": {
    "columns": [...]
  },
  "footer": {
    "pageNumber": true
  }
}
```

## Despliegue

El Container de FluentReport se despliega desde el repo [MathiasGonzalez/FluentReport](https://github.com/MathiasGonzalez/FluentReport). El Worker de Adviser solo configura el binding.

```bash
# Desde el repo FluentReport (cuando esté disponible el API wrapper)
wrangler deploy
```

## Consideraciones de performance

| Aspecto | Valor |
|---------|-------|
| Cold start del Container | ~1.5–3 s (primera request tras `sleepAfter`) |
| Generación PDF A4 típico | ~200–500 ms (tras warm-up) |
| `sleepAfter` configurado | 5 minutos de inactividad |
| Instancias | 1 compartida (`"default"`) — stateless |

Para minimizar cold starts en horarios de alta actividad (liquidaciones de fin de mes), se puede aumentar `sleepAfter` a `"30m"` temporalmente.
