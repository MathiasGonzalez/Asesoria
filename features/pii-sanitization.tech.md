# Tech Spec: PII Sanitization

## Stack

Pura lógica TypeScript dentro del Worker. Sin bindings adicionales.

## Estructura de archivos

```
src/
└── services/anonymizer.ts    # Anonymizer.sanitize(text: string): string
```

## Patrones regex (v1)

| PII | Patrón | Reemplazo |
|-----|--------|-----------|
| CI uruguaya | `\b\d{1,2}[.-]?\d{3}[.-]?\d{3}[.-]?\s?\d?\b` | `[CI_REDACTADA]` |
| RUT (12 dígitos) | `\b(12\|21)\d{10}\b` | `[RUT_REDACTADO]` |
| Montos UYU/USD | `(\$U\|\$\|USD)\s?(\d{1,3}(\.\d{3})*(,\d+)?)` | `[MONTO_REDACTADO]` |

## Integración en el pipeline

```typescript
// src/routes/search.ts
const sanitized = Anonymizer.sanitize(query)
const result = await ragService.searchNormative(sanitized)
return { originalQuery: query, sanitizedQuery: sanitized, response: result.text }
```

La sanitización se aplica **antes** de cualquier llamada a Workers AI y antes de cualquier log.

## Extensiones pendientes (obligatorio en Fase 2)

- Named Entity Recognition (NER) para nombres propios: usar `@cf/meta/llama-3-8b-instruct` con un prompt de extracción de entidades antes del RAG.
- Documentar en esta tech spec cuando se implemente.
