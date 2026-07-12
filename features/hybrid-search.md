# Feature: Hybrid Search (Búsqueda Híbrida Semántica + Léxica)

## Descripción

Sistema de recuperación que combina dos estrategias complementarias para maximizar la precisión en la búsqueda de normativa uruguaya:

1. **Búsqueda semántica** via Vectorize: captura similitud conceptual y paráfrasis.
2. **Búsqueda léxica FTS5** via D1 SQLite: captura coincidencias exactas de términos técnicos, números de artículos y citas legales específicas.

## Casos de uso

- **UC-009** El usuario escribe "deducción gastos empresa" — la búsqueda semántica recupera fragmentos sobre deducciones del IRAE aunque usen vocabulario diferente.
- **UC-010** El usuario escribe "Art. 52 Decreto 150/007" — la búsqueda léxica FTS5 recupera el fragmento exacto por coincidencia de términos.
- **UC-011** El sistema fusiona ambos conjuntos de resultados y deduplica por ID antes de recuperar el texto completo de la base D1.
- **UC-012** En entornos con corpus pequeño, FTS5 actúa como fallback cuando Vectorize no encuentra coincidencias semánticas suficientes.

## Implementación

### Vectorize (semántica)
```typescript
const vectorMatches = await this.env.VECTORIZE.query(queryVector, {
  topK: limit,
  returnMetadata: "all"
});
```

### D1 FTS5 (léxica)
```sql
SELECT chunk_id FROM document_chunks_fts 
WHERE document_chunks_fts MATCH ? LIMIT ?
```

### Merge
```typescript
const allIds = Array.from(new Set([...semIds, ...ftsIds]));
```

## Estructura de base de datos

| Tabla | Propósito |
|-------|-----------|
| `documents` | Documento completo con metadatos (fuente, URL, fecha) |
| `document_chunks` | Fragmentos con texto y resumen contextual |
| `document_chunks_fts` | Índice FTS5 virtual mantenido por triggers |

### Triggers automáticos FTS5
- `after_chunk_insert`: indexa al insertar un chunk (texto + contexto)
- `after_chunk_delete`: elimina del índice al borrar un chunk

## Índice Vectorize

- **Nombre:** `advisor-uy-index`
- **Dimensiones:** 768 (modelo bge-base-en-v1.5)
- **Métrica:** cosine similarity
- **Metadatos almacenados:** `document_id`, `source`
