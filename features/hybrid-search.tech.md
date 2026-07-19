# Tech Spec: Hybrid Search

## Stack

Worker Hono + D1 FTS5 + Vectorize. Comparte bindings con Contextual RAG.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tabla `document_chunks_fts` (índice FTS5 virtual) |
| `VECTORIZE` | Vectorize | Búsqueda semántica top-K |
| `AI` | Workers AI | Generación del vector de la query |

## Estructura de archivos

```
src/
└── services/rag.ts    # searchNormative(): fusión semántica + léxica
```

## Triggers FTS5 (D1)

Los triggers se definen en la migración `0002_rag.sql` y mantienen el índice sincronizado automáticamente:

```sql
-- Inserción
CREATE TRIGGER after_chunk_insert AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(chunk_id, content, context)
  VALUES (new.id, new.content, new.context);
END;

-- Eliminación
CREATE TRIGGER after_chunk_delete AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE chunk_id = old.id;
END;
```

## Notas de implementación

- La fusión de resultados usa `Array.from(new Set([...semIds, ...ftsIds]))` para deduplicar.
- FTS5 actúa como fallback cuando el corpus es pequeño (< 10 documentos) y Vectorize no tiene matches suficientes.
- La búsqueda léxica usa el operador `MATCH` de SQLite FTS5, compatible con términos técnicos (`Art. 52`, números de decretos).
