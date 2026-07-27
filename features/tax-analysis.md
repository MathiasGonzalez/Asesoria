# Feature: Tax Situation Analysis (Análisis de Situación Impositiva)

## Descripción

Módulo de análisis tributario mensual para Uruguay (DGI/BPS). Permite a usuarios y estudios contables crear períodos fiscales mensuales, adjuntar documentación contable y obtener un análisis consolidado generado por IA con las obligaciones impositivas del período.

## Casos de uso

- **UC-030** Un contador crea el período "Marzo 2025" para una empresa SRL, sube el libro de IVA y la planilla de sueldos, y ejecuta el análisis. El sistema devuelve el consolidado con IVA, IRAE anticipo, IRPF retenciones y BPS desglosados.
- **UC-031** Un monotributista sube su resumen bancario en PDF y obtiene un análisis de su cuota mensual y próximos vencimientos.
- **UC-032** El período queda en estado `draft` hasta que se ejecuta la consolidación IA; luego pasa a `analyzed`. El badge cambia de "Pendiente" a "Analizado".
- **UC-033** El usuario puede volver a analizar un período (re-análisis) al subir documentos adicionales.

## Modelo de datos

```sql
tax_periods (id, user_id, tenant_id, month, year, label, status, company_id, notas)
  UNIQUE(user_id, month, year)  -- un período por empresa/persona por mes

tax_documents (id, period_id, user_id, filename, content, doc_type,
               r2_key, mime_type, file_size, source, source_url)
  -- content: texto extraído para IA (máx 8.000 chars)
  -- r2_key:  clave en el bucket R2 del archivo original

tax_consolidations (id, period_id, raw_response)
  UNIQUE(period_id)  -- se sobreescribe en cada re-análisis
```

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`    | `/api/tax/periods` | Lista períodos del usuario autenticado |
| `POST`   | `/api/tax/periods` | Crea un período (`month`, `year`, `company_id?`, `notas?`) |
| `DELETE` | `/api/tax/periods/:id` | Elimina un período y sus documentos |
| `GET`    | `/api/tax/periods/:id/documents` | Lista documentos del período + metadatos de empresa |
| `POST`   | `/api/tax/periods/:id/documents` | Agrega documento vía JSON (`filename`, `content`, `doc_type`) |
| `POST`   | `/api/tax/periods/:id/upload` | Carga archivo a R2 vía `multipart/form-data` |
| `POST`   | `/api/tax/periods/:id/import-gdoc` | Importa texto desde Google Docs/Sheets público |
| `GET`    | `/api/tax/periods/:id/documents/:docId/download` | Descarga archivo original desde R2 |
| `DELETE` | `/api/tax/periods/:id/documents/:docId` | Elimina documento (y archivo R2 si existe) |
| `POST`   | `/api/tax/periods/:id/consolidate` | Ejecuta análisis IA y guarda consolidado |
| `GET`    | `/api/tax/periods/:id/consolidation` | Devuelve resultado almacenado |

## Tipos de documento soportados

Agrupados por categoría en la UI:

| Código | Descripción |
|--------|-------------|
| `factura_venta` / `factura_compra` | Comprobantes de facturación |
| `libro_iva_ventas` / `libro_iva_compras` | Libros de IVA |
| `planilla_sueldos` / `nomina_bps` | Nómina y seguridad social |
| `declaracion_dgi` | Formularios DGI (1101, 1102, 2181, FF) |
| `resumen_bancario` / `balance_general` | Registros contables |

## Análisis IA — output esperado

El modelo `@cf/qwen/qwq-32b` devuelve un objeto JSON con:

```json
{
  "periodo": "Marzo 2025",
  "resumen": "descripción de la situación global",
  "impuestos": [
    {
      "tipo": "IVA — Formulario FF",
      "base_imponible": 150000,
      "tasa": 22,
      "monto_estimado": 33000,
      "vencimiento": "20/04/2025",
      "estado": "a_pagar",
      "notas": "Vence el día 20 por ser CEDE"
    }
  ],
  "alertas": ["El anticipo IRAE supera el estimado del mes anterior."],
  "recomendaciones": ["Verificar si corresponde solicitar devolución de IVA exportador."],
  "total_a_pagar": 45500
}
```

## Páginas

- `/app/impuestos` — cuadrícula de períodos con badges de estado y modal de creación
- `/app/impuestos/periodo?id=` — vista de detalle con pestañas Documentos / Análisis

## Mejoras futuras (v3)

- Extracción automática de texto de PDF con Workers AI OCR
- Notificaciones de vencimiento por email (D-5 antes de cada fecha)
- Exportación del consolidado como PDF
- Comparación entre períodos

## Checklist de implementación

### Base de datos
- [x] Tabla `tax_periods` creada con `UNIQUE(user_id, month, year, company_id)`
- [x] Tabla `tax_documents` creada con metadatos R2 (`r2_key`, `mime_type`, `file_size`, `source`)
- [x] Tabla `tax_consolidations` creada con `UNIQUE(period_id)` para sobreescribir en re-análisis

### Backend
- [x] `GET /api/tax/periods` — lista períodos del usuario autenticado
- [x] `POST /api/tax/periods` — crea período con `month`, `year`, `company_id?`, `notas?`
- [x] `DELETE /api/tax/periods/:id` — elimina período y todos sus documentos
- [x] `GET /api/tax/periods/:id/documents` — lista documentos con metadatos de empresa
- [x] `POST /api/tax/periods/:id/documents` — agrega documento vía JSON
- [x] `POST /api/tax/periods/:id/upload` — carga archivo multipart a R2
- [x] `POST /api/tax/periods/:id/import-gdoc` — importa desde Google Docs/Sheets público
- [x] `GET /api/tax/periods/:id/documents/:docId/download` — descarga desde R2
- [x] `DELETE /api/tax/periods/:id/documents/:docId` — elimina documento
- [x] `POST /api/tax/periods/:id/consolidate` — ejecuta análisis con `@cf/qwen/qwq-32b`, guarda en `tax_consolidations`
- [x] `GET /api/tax/periods/:id/consolidation` — retorna resultado almacenado

### Frontend
- [x] `/app/impuestos` — cuadrícula de períodos con badges de estado y modal de creación
- [x] `/app/impuestos/periodo?id=` — vista de detalle con pestañas Documentos / Análisis

### Validación
- [x] UC-030: análisis de SRL con libro IVA + planilla de sueldos — consolidado correcto
- [x] UC-031: monotributista con resumen bancario PDF obtiene cuota y vencimientos
- [x] UC-032: ciclo de estados `draft` → `analyzed` funciona correctamente
- [x] UC-033: re-análisis con documento adicional sobreescribe consolidación anterior

### Pendiente (v2)
- [ ] OCR automático de PDFs (Workers AI)
- [ ] Notificaciones de vencimiento por email (D-5)
- [ ] Exportación del consolidado como PDF via FluentReport
- [ ] Comparación entre períodos
