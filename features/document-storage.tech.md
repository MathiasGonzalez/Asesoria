# Tech Spec: Document Storage (R2)

## Stack

Worker Hono + D1 + R2. El binding R2 es opcional para permitir desarrollo local sin R2.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tabla `tax_documents` con columnas de metadatos R2 |
| `DOCUMENTS_BUCKET` | R2 (opcional) | Almacenamiento de archivos originales |

```jsonc
// wrangler.jsonc
"r2_buckets": [
  { "binding": "DOCUMENTS_BUCKET", "bucket_name": "adviser-documents" }
]
```

## Estructura de archivos

```
src/
├── routes/tax.ts           # POST /upload, GET /download, POST /import-gdoc
└── services/storage.ts     # Abstracción R2: put(), get(), delete()
```

## Esquema D1

Migración: `migrations/0007_r2_documents.sql`

```sql
ALTER TABLE tax_documents ADD COLUMN r2_key     TEXT;
ALTER TABLE tax_documents ADD COLUMN mime_type  TEXT;
ALTER TABLE tax_documents ADD COLUMN file_size  INTEGER;
ALTER TABLE tax_documents ADD COLUMN source     TEXT NOT NULL DEFAULT 'paste';
ALTER TABLE tax_documents ADD COLUMN source_url TEXT;
```

## Estructura de claves R2

```
tax/{userId}/{periodId}/{uuid}/{filename}
```

## Límites

| Parámetro | Valor |
|-----------|-------|
| Tamaño máximo por archivo | 10 MB |
| Texto extraído (content en D1) | 8.000 chars |
| Texto truncado | Sí, con nota al final |

## Creación de buckets

```bash
npx wrangler r2 bucket create adviser-documents
npx wrangler r2 bucket create adviser-documents-develop
```

## Extracción de texto

| MIME type | Estrategia |
|-----------|-----------|
| `text/*`, `.csv`, `.json`, `.md` | Extracción directa (TextDecoder) |
| `application/pdf` | Workers AI OCR (Fase 2) — hoy: vacío, usuario complementa |
| `application/vnd.openxmlformats*` | Sin extracción automática (Fase 2) |
