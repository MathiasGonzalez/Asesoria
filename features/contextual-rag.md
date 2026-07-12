# Feature: Contextual RAG (Recuperación Aumentada con Contexto)

## Descripción

Implementación del método **Contextual Retrieval Augmented Generation (RAG)** sobre el corpus legislativo uruguayo. A diferencia del RAG clásico, cada fragmento de documento se enriquece automáticamente con un resumen contextual generado por IA al momento de la ingestión, previniendo la pérdida de referencias jerárquicas y mejorando la precisión de la recuperación semántica.

## Casos de uso

- **UC-005** Un asesor consulta sobre plazos de fiscalización de DGI. El sistema recupera el fragmento normativo exacto con su fuente citada y enlace verificable.
- **UC-006** Se ingest un nuevo Decreto del Poder Ejecutivo sobre IRAE. El sistema contextualiza cada chunk indicando su posición en el decreto antes de vectorizarlo.
- **UC-007** El modelo generativo solo puede responder con información del contexto recuperado y debe citar la fuente textualmente, previniendo alucinaciones.
- **UC-008** Si el contexto no cubre la consulta, el sistema responde honestamente indicando que la información no está disponible en el corpus actual.

## Flujo de ingestión

```
Documento fuente
  → chunking (ventanas de 500 chars)
  → contextualización por AI (llama-3-8b-instruct)
  → almacenamiento en D1 (document_chunks)
  → embedding (bge-base-en-v1.5, 768 dims)
  → upsert en Vectorize index
```

## Flujo de consulta

```
Query sanitizada
  → embedding (bge-base-en-v1.5)
  → búsqueda semántica en Vectorize (top-K)
  → búsqueda léxica en D1 FTS5
  → merge y deduplicación de IDs
  → fetch de chunks completos con metadatos
  → construcción del contexto grounded
  → generación con qwq-32b
```

## Implementación

- **Archivo:** `src/services/rag.ts`
- **Método de ingestión:** `RagService.ingestDocument()`
- **Método de búsqueda:** `RagService.searchNormative()`
- **Endpoint de ingestión:** `POST /api/ingest`
- **Endpoint de consulta:** `GET /api/search?q=`

## Parámetros clave

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| `windowSize` | 500 chars | Tamaño de chunk para fraccionamiento |
| `topK` | 3 | Resultados semánticos a recuperar |
| `fts limit` | 3 | Resultados léxicos a recuperar |
| Modelo contexto | `@cf/meta/llama-3-8b-instruct` | Genera el resumen contextual |
| Modelo embedding | `@cf/baai/bge-base-en-v1.5` | Genera vectores (768 dims) |
| Modelo respuesta | `@cf/qwen/qwq-32b` | Genera la respuesta final |
