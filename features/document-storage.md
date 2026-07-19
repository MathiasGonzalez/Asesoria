# Feature: Document Storage with R2 (Almacenamiento de Documentos)

## Descripción

Almacenamiento persistente de archivos contables en **Cloudflare R2** (object storage compatible con S3). Permite subir cualquier tipo de archivo (PDF, CSV, XLSX, TXT, etc.) para su archivo permanente, con extracción automática de texto para análisis de IA. Incluye importación directa desde Google Docs y Google Sheets sin instalar extensiones.

## Casos de uso

- **UC-040** Un contador sube un PDF de la boleta BPS. El archivo queda guardado en R2. Si es un PDF de texto (no escaneado), el Worker extrae el contenido automáticamente; de lo contrario, el usuario puede complementar con el texto vía paste.
- **UC-041** Una empresa comparte su planilla de sueldos en Google Sheets con "Cualquier persona con el enlace puede ver". El usuario pega el enlace en la app y el sistema importa el CSV automáticamente.
- **UC-042** Un usuario descarga el archivo original desde la lista de documentos del período.
- **UC-043** Al eliminar un documento, el archivo correspondiente en R2 se borra en background (no bloquea la respuesta).

## Fuentes de documentos (`source`)

| Valor | Descripción |
|-------|-------------|
| `upload` | Archivo subido vía drag-and-drop o selector de archivos |
| `gdoc`   | Texto importado desde Google Docs o Sheets público |
| `paste`  | Texto pegado manualmente en el formulario |

## API endpoints nuevos

### `POST /api/tax/periods/:id/upload`

Acepta `multipart/form-data` con:

| Campo | Tipo | Requerido |
|-------|------|-----------|
| `file` | File | Sí |
| `doc_type` | string | No |

- Límite: **10 MB** por archivo.
- Para archivos de texto (`text/*`, `.txt`, `.csv`, `.json`, `.md`, etc.): extrae texto automáticamente y lo guarda en D1 (truncado a 8.000 chars).
- Para archivos binarios (PDF, XLSX, imágenes): guarda en R2; el contenido para IA quedará vacío salvo que el usuario lo complemente con texto manual.
- Devuelve `text_extracted: true|false` para indicar si se pudo extraer texto.

```json
// POST /api/tax/periods/{id}/upload — respuesta
{
  "ok": true,
  "document": {
    "id": "uuid",
    "filename": "planilla_marzo.csv",
    "doc_type": "planilla_sueldos",
    "content_length": 3200,
    "mime_type": "text/csv",
    "file_size": 4096,
    "has_file": true,
    "text_extracted": true
  }
}
```

### `POST /api/tax/periods/:id/import-gdoc`

Importa texto desde un enlace de Google Docs o Google Sheets **compartido como público**.

```json
// Body
{
  "url": "https://docs.google.com/document/d/1BxiMV.../edit",
  "doc_type": "planilla_sueldos",
  "filename": "planilla_sueldos_marzo.txt"  // opcional
}
```

- Para Google Docs: exporta en formato `txt`.
- Para Google Sheets: exporta en formato `csv`.
- El documento **debe estar compartido** con "Cualquier persona con el enlace puede ver".
- Trunca a 8.000 caracteres si el documento es muy extenso.

### `GET /api/tax/periods/:id/documents/:docId/download`

Devuelve el archivo original almacenado en R2 como descarga (`Content-Disposition: attachment`).

- Responde 404 si el documento fue creado vía paste/gdoc (sin archivo binario).
- Requiere autenticación y que el período pertenezca al usuario.

## Configuración de infraestructura

### Cloudflare R2 — crear bucket

```bash
# Producción
npx wrangler r2 bucket create adviser-documents

# Desarrollo
npx wrangler r2 bucket create adviser-documents-develop
```

### Binding en `wrangler.jsonc`

```json
"r2_buckets": [
  { "binding": "DOCUMENTS_BUCKET", "bucket_name": "adviser-documents" }
]
```

La binding es **opcional** en local dev: si `DOCUMENTS_BUCKET` no está configurado, el endpoint de upload almacena el texto en D1 pero omite el guardado en R2.

## Estructura de claves R2

```
tax/{userId}/{periodId}/{uuid}/{filename}
```

## Migración de base de datos

```sql
-- migrations/0007_r2_documents.sql
ALTER TABLE tax_documents ADD COLUMN r2_key     TEXT;
ALTER TABLE tax_documents ADD COLUMN mime_type  TEXT;
ALTER TABLE tax_documents ADD COLUMN file_size  INTEGER;
ALTER TABLE tax_documents ADD COLUMN source     TEXT NOT NULL DEFAULT 'paste';
ALTER TABLE tax_documents ADD COLUMN source_url TEXT;
```

Correr con:
```bash
npm run db:migrate:remote
```

## Mejoras futuras (v2)

- OCR automático para PDFs escaneados usando Workers AI vision
- Soporte para Google Drive con OAuth (acceso a documentos privados)
- Cuota de almacenamiento por usuario / tenant
- Expiración automática de archivos de períodos cerrados
