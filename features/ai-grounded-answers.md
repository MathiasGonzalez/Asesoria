# Feature: AI Grounded Answers (Respuestas Fundamentadas con IA)

## Descripción

Generación de respuestas de asesoramiento tributario usando el modelo `@cf/qwen/qwq-32b` de Workers AI, condicionada estrictamente al contexto normativo recuperado. El modelo está instruido para no alucinar leyes ni inventar citas, y para indicar honestamente cuando la información no está disponible en el corpus.

## Casos de uso

- **UC-017** Un contador consulta "¿Qué plazo tiene una auditoría fiscal de DGI?". El sistema responde citando textualmente el artículo y decreto aplicable con enlace a la fuente.
- **UC-018** Se realiza una consulta fuera del corpus (p.e. derecho laboral). El sistema responde: "La información solicitada no está disponible en el contexto normativo actual."
- **UC-019** La respuesta incluye la latencia de procesamiento (`latencyMs`) para transparencia operativa.
- **UC-020** El campo `sanitizedQuery` permite al frontend alertar al usuario si su consulta fue anonimizada antes del procesamiento.

## Estructura de la respuesta

```json
{
  "originalQuery": "¿Qué plazo tiene una auditoría fiscal de DGI?",
  "sanitizedQuery": "¿Qué plazo tiene una auditoría fiscal de DGI?",
  "response": "Según el Artículo 72 del Código Tributario uruguayo...\n[Fuente: DGI | T.O. DGI 1996 | https://...]",
  "latencyMs": 1240
}
```

## Prompt del sistema (system prompt)

El modelo recibe instrucciones estrictas:

1. Responder **exclusivamente** con base en el contexto normativo provisto.
2. No alucinar leyes, decretos ni artículos que no estén en el contexto.
3. Citar textualmente la fuente legal con enlace verificable.
4. Operar completamente en español.
5. Si el contexto no cubre la consulta, indicarlo de forma honesta.

## Modelo utilizado

| Propiedad | Valor |
|-----------|-------|
| Modelo | `@cf/qwen/qwq-32b` |
| Proveedor | Cloudflare Workers AI |
| Latencia típica | 800–2000ms (edge inference) |
| Idioma de operación | Español |

## Endpoint

```
GET /api/search?q={consulta}
```

## Garantías de calidad

- Cada respuesta está fundamentada en fuentes reales del corpus legislativo.
- El contexto recuperado se incluye en el prompt (Contextual RAG).
- El modelo no tiene acceso a internet ni a datos fuera del contexto provisto.
- Las respuestas son auditables: el fragmento legislativo fuente siempre se puede trazar.

## Checklist de implementación

### Backend
- [x] Prompt del sistema con instrucciones de grounding estricto implementado
- [x] Generación con `@cf/qwen/qwq-32b` usando el contexto RAG recuperado
- [x] Respuesta incluye `originalQuery`, `sanitizedQuery`, `response`, `latencyMs`
- [x] Modelo instruido para citar fuentes y rechazar respuestas fuera del corpus

### Infraestructura
- [x] Binding `AI` en `wrangler.jsonc`

### Validación
- [x] UC-017: respuesta cita textualmente artículo y decreto con enlace
- [x] UC-018: respuesta honesta cuando la consulta está fuera del corpus
- [x] UC-019: campo `latencyMs` presente en la respuesta
- [x] UC-020: campo `sanitizedQuery` refleja la anonimización aplicada
- [x] Ninguna respuesta inventada sin fuente en el corpus verificado
