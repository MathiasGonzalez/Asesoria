# Tech Spec: Document Ingestion

## Stack

Worker Hono + D1 + Vectorize + Workers AI. Comparte bindings con Contextual RAG.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Persistencia de `documents` y `document_chunks` |
| `VECTORIZE` | Vectorize | Upsert de embeddings tras ingestión |
| `AI` | Workers AI | `bge-m3` para embeddings; `llama-3-8b-instruct` para contexto |

## Estructura de archivos

```
src/
├── routes/ingest.ts          # POST /api/ingest
└── services/rag.ts           # RagService.ingestDocument()
```

## Endpoint

```
POST /api/ingest
Authorization: <session-token>    (requiere rol admin)
Content-Type: application/json

{
  "id":      "to-dgi-96-titulo1",
  "title":   "T.O. DGI 1996 - Título 1",
  "source":  "DGI",
  "content": "...",
  "url":     "https://..."
}
```

## Flujo de ingestión

```
content → chunking (500 chars)
  → por cada chunk:
    → llama-3-8b-instruct (contexto 1-2 oraciones)
    → bge-m3 embedding (1024 dims)
    → D1 INSERT document_chunks
    → Vectorize upsert
  → D1 INSERT documents
```

## Feature flag

La ingestión está protegida por el flag `document_ingestion_enabled`. Si está deshabilitado, el endpoint devuelve `403`.

## Acceso

Solo usuarios con rol `admin` u `owner` pueden llamar a este endpoint. El middleware verifica el rol antes de ejecutar la ingestión.

## Checklist de implementación técnica

- [x] `POST /api/ingest` implementado en `src/routes/ingest.ts`
- [x] Chunking por ventanas de 500 chars
- [x] Contextualización por chunk con `@cf/meta/llama-3-8b-instruct`
- [x] Upsert en Vectorize con metadatos `document_id`, `source`
- [x] Bindings `DB`, `VECTORIZE`, `AI` en `wrangler.jsonc`
