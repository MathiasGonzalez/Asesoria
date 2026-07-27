# Tech Spec: AI Grounded Answers

## Stack

Worker Hono + Workers AI (`qwq-32b`). Comparte bindings con Contextual RAG.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `AI` | Workers AI | Modelo `@cf/qwen/qwq-32b` para generación de respuesta |
| `DB` | D1 | Fetch de chunks completos con metadatos tras la búsqueda |
| `VECTORIZE` | Vectorize | Búsqueda semántica (delegado a RAG service) |

## Estructura de archivos

```
src/
├── services/rag.ts        # RagService.searchNormative() — orquesta todo el pipeline
└── routes/search.ts       # GET /api/search?q= — endpoint público
```

## Contrato del endpoint

```
GET /api/search?q={consulta sanitizada}

Respuesta:
{
  "originalQuery":   string,
  "sanitizedQuery":  string,
  "response":        string,   // texto generado con citas
  "latencyMs":       number
}
```

## System prompt

El system prompt es inmutable y está embebido en `rag.ts`. Define:
1. Responder solo con el contexto provisto.
2. Citar la fuente textualmente.
3. No inventar leyes ni decretos.
4. Operar en español.
5. Responder honestamente cuando la información no está disponible.

## Latencia típica

- Embedding query: ~50 ms
- Vectorize search: ~80 ms
- D1 FTS5: ~20 ms
- AI generation (`qwq-32b`): 800–2000 ms
- **Total**: 950–2150 ms (edge inference sin cold start)

## Checklist de implementación técnica

- [x] Prompt del sistema con grounding estricto implementado en `src/services/rag.ts`
- [x] Modelo `@cf/qwen/qwq-32b` configurado en Workers AI
- [x] Respuesta incluye `originalQuery`, `sanitizedQuery`, `response`, `latencyMs`
- [x] Binding `AI` en `wrangler.jsonc`
