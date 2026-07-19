# Tech Spec: Contextual RAG

## Stack

Worker Hono + D1 (chunks + FTS5) + Vectorize + Workers AI.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `documents`, `document_chunks`, `document_chunks_fts` |
| `VECTORIZE` | Vectorize | Índice `advisor-uy-index` (1024 dims, cosine, modelo `bge-m3`) |
| `AI` | Workers AI | Embedding (`bge-m3`) + contexto (`llama-3-8b-instruct`) + respuesta (`qwq-32b`) |

## Estructura de archivos

```
src/
├── services/rag.ts              # RagService: ingestDocument(), searchNormative()
└── services/anonymizer.ts       # PII sanitization aplicada antes del RAG
```

## Esquema D1

Migración: `migrations/0002_rag.sql`

```sql
CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, source TEXT, url TEXT, created_at INTEGER);
CREATE TABLE document_chunks (id TEXT PRIMARY KEY, document_id TEXT, chunk_index INTEGER,
  content TEXT, context TEXT);
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  chunk_id UNINDEXED, content, context,
  content=document_chunks, content_rowid=rowid
);
```

## Parámetros clave

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| `windowSize` | 500 chars | Tamaño de chunk |
| `topK` | 3 | Resultados semánticos |
| `fts limit` | 3 | Resultados léxicos |
| Modelo embedding | `@cf/baai/bge-m3` | 1024 dims, multilingüe |
| Modelo contexto | `@cf/meta/llama-3-8b-instruct` | Resumen contextual por chunk |
| Modelo respuesta | `@cf/qwen/qwq-32b` | Generación final |

## Notas de despliegue

```bash
# Crear índice Vectorize (1024 dims para bge-m3)
npx wrangler vectorize create advisor-uy-index --dimensions=1024 --metric=cosine
```

Si se migra desde `bge-base-en-v1.5` (768 dims), recrear el índice y re-ingestar todos los documentos.
