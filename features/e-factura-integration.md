# Feature: Integración e-Factura / CFE (Comprobantes Fiscales Electrónicos)

## Descripción

Integración con el sistema de **Comprobantes Fiscales Electrónicos (CFE)** de la DGI uruguaya para emisión, recepción y almacenamiento de facturas electrónicas (e-Factura, e-Ticket, e-Remito, e-Resguardo). Permite a PyMEs y estudios contables emitir CFEs sin salir de la plataforma y alimentar automáticamente los libros de IVA para el análisis impositivo.

## Casuística de mercado

La **e-Factura es obligatoria para todas las empresas uruguayas** que superen ciertos topes de facturación (o que lo hayan adoptado voluntariamente). Este es uno de los mayores generadores de trabajo repetitivo en estudios contables:

- Las empresas pequeñas pagan ~$1.500–3.000 UYU/mes a proveedores de e-Factura (Uruware, Equifax, Defontana, GTX) solo por timbrar facturas.
- El libro de IVA debe alimentarse mensualmente con los CFEs emitidos y recibidos — proceso hoy manual en muchas PyMEs.
- Los errores en CFEs (RUTs mal formateados, montos IVA incorrectos) generan observaciones DGI.
- La recepción y validación de CFEs de proveedores es un proceso manual sin automatizar para la mayoría de las empresas.

## Casos de uso

- **UC-080** Una empresa emite una e-Factura a un cliente ingresando RUT, monto, tasa IVA y concepto. El sistema genera el XML firmado, lo envía a DGI via e.facturas y devuelve el CFE con número de serie.
- **UC-081** Al cerrar el mes, el sistema genera automáticamente el libro de IVA Ventas sumando todos los CFEs emitidos y lo ingesta como documento del período fiscal de análisis.
- **UC-082** El sistema recibe los CFEs de proveedores (vía buzón DGI o carga manual de XML) y los clasifica en el libro de IVA Compras.
- **UC-083** Un estudio contable configura su cliente en la plataforma con sus credenciales DGI (certificado digital) y emite facturas en nombre del cliente.
- **UC-084** Al detectar un CFE con IVA mal calculado, el sistema alerta antes del envío a DGI.
- **UC-085** Una empresa con exoneración de IVA (p.e. exportadora) emite e-Remitos y e-Tickets con tasa 0 correctamente.

## Modelo de datos

```sql
cfe_configs (
  id, user_id, tenant_id, company_id,
  rut_emisor        TEXT,
  razon_social      TEXT,
  certificado_b64   TEXT,   -- certificado digital DGI (cifrado en reposo)
  serie_inicio      INTEGER,
  ambiente          TEXT,   -- homologacion | produccion
  proveedor         TEXT    -- uruware | gtx | directo_dgi
)

cfe_documents (
  id, user_id, tenant_id, company_id,
  tipo_cfe          TEXT,   -- eFact | eTicket | eRemito | eResguardo | eFact_export
  numero            INTEGER,
  serie             TEXT,
  fecha_emision     DATE,
  rut_receptor      TEXT,
  razon_receptor    TEXT,
  subtotal          REAL,
  iva_tasa          TEXT,   -- 22 | 10 | 0 | exento
  monto_iva         REAL,
  total             REAL,
  estado            TEXT,   -- borrador | enviado | aceptado | rechazado | anulado
  cfe_xml           TEXT,   -- XML firmado
  cae_numero        TEXT,   -- código asignado por DGI
  periodo_id        TEXT    -- FK a tax_periods (para alimentar el libro IVA)
)
```

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST`   | `/api/cfe/config` | Configura credenciales DGI para una empresa |
| `POST`   | `/api/cfe/emit` | Emite un CFE (valida, firma, envía a DGI) |
| `GET`    | `/api/cfe/documents` | Lista CFEs emitidos/recibidos |
| `GET`    | `/api/cfe/documents/:id/pdf` | Genera representación impresa (PDF) del CFE |
| `GET`    | `/api/cfe/documents/:id/xml` | Descarga el XML original del CFE |
| `POST`   | `/api/cfe/documents/:id/annul` | Solicita anulación ante DGI |
| `POST`   | `/api/cfe/import-inbox` | Importa CFEs recibidos del buzón DGI |
| `POST`   | `/api/cfe/generate-iva-book` | Genera libro IVA del mes e ingesta en tax_periods |

## Tipos de CFE soportados

| Tipo | Código DGI | Descripción |
|------|-----------|-------------|
| e-Factura | 111 | Operaciones con IVA — empresa a empresa |
| e-Ticket | 101 | Operaciones con IVA — empresa a consumidor final |
| e-Factura Exportación | 112 | Ventas al exterior — IVA tasa 0 |
| e-Remito | 181/182 | Traslado de bienes |
| e-Resguardo | 182 | Retenciones de IRPF / IVA |
| Nota Crédito e-Factura | 113 | Correcciones y devoluciones |

## Validaciones pre-envío

- RUT receptor válido (12 dígitos, dígito verificador correcto).
- Monto IVA coherente con tasa y base imponible.
- Fecha de emisión no mayor a 72 horas anteriores.
- Certificado digital vigente (alerta si vence en menos de 30 días).
- Coherencia entre tipo de CFE y regimen fiscal de la empresa.

## Integración con análisis impositivo

Al ejecutar `/api/cfe/generate-iva-book?month=3&year=2025&company_id=...`:

1. Consulta todos los CFEs emitidos y recibidos del período.
2. Genera un CSV/resumen con base imponible, IVA al 22% e IVA al 10%.
3. Lo crea como `tax_document` de tipo `libro_iva_ventas` / `libro_iva_compras` en el período correspondiente.
4. El análisis IA del período ya cuenta con el libro actualizado.

## Páginas

- `/app/facturacion` — Panel de CFEs con filtros por tipo, estado y fecha
- `/app/facturacion/nueva` — Formulario de emisión de CFE con preview antes del envío
- `/app/facturacion/config` — Configuración de certificado digital y serie

## Mejoras futuras (v2)

- Integración directa con API de proveedores homologados (Uruware, GTX)
- Autofill de RUT receptor desde catálogo público DGI
- Facturación recurrente (suscripciones mensuales automatizadas)
- Portal de facturas públicas para que receptores descarguen sus CFEs sin login
- Soporte multi-moneda (USD, EUR) con tipo de cambio BCU automático

## Checklist de implementación

### Prerequisito
- [ ] Repositorio `MathiasGonzalez/UruFactura` desplegado como Cloudflare Container (Durable Object por empresa)
- [ ] Binding `URUFACTURA_CONTAINER` configurado en `wrangler.jsonc`

### Base de datos
- [ ] Tabla `cfe_configs` creada (con `certificado_b64` cifrado en reposo)
- [ ] Tabla `cfe_documents` creada con índices por `(tenant_id, company_id, fecha_emision)`

### Backend
- [ ] `POST /api/cfe/config` — configura credenciales DGI para una empresa (certificado cifrado)
- [ ] `POST /api/cfe/emit` — valida, firma y envía CFE a DGI via UruFactura Container
- [ ] `GET /api/cfe/documents` — lista CFEs emitidos/recibidos del tenant
- [ ] `GET /api/cfe/documents/:id/pdf` — genera representación impresa PDF via FluentReport
- [ ] `GET /api/cfe/documents/:id/xml` — descarga XML original del CFE
- [ ] `POST /api/cfe/documents/:id/annul` — solicita anulación ante DGI
- [ ] `POST /api/cfe/import-inbox` — importa CFEs recibidos del buzón DGI (XML)
- [ ] `POST /api/cfe/generate-iva-book` — genera libro IVA del mes e ingesta en `tax_periods`
- [ ] Validación de RUT del receptor antes de enviar a DGI
- [ ] Alerta antes del envío si el IVA calculado no coincide con el monto total
- [ ] Tipos de CFE soportados: e-Factura (111), e-Ticket (101), exportación (112), e-Remito, e-Resguardo, Nota Crédito

### Infraestructura
- [ ] UruFactura Container desplegado y en estado `running`
- [ ] FluentReport Container disponible para generación de PDF de CFE

### Frontend
- [ ] `/app/facturacion` — lista de CFEs con filtros por tipo, estado y período
- [ ] `/app/facturacion/nueva` — formulario de emisión de CFE
- [ ] `/app/facturacion/config` — configuración de credenciales DGI por empresa

### Validación
- [ ] UC-080: emisión de e-Factura retorna XML firmado con CAE de DGI
- [ ] UC-081: libro IVA Ventas generado automáticamente al cerrar el mes
- [ ] UC-082: CFE de proveedor importado y clasificado en libro IVA Compras
- [ ] UC-083: estudio emite CFE en nombre de cliente con sus credenciales DGI
- [ ] UC-084: alerta disparada al detectar IVA mal calculado antes de enviar
- [ ] UC-085: e-Ticket con tasa 0 emitido correctamente para empresa exportadora
