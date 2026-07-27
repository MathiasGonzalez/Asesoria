# Tech Spec: Rate Limiting

## Stack

Workers Rate Limiting nativo (binding Cloudflare). Sin D1 ni lógica adicional.

## Bindings requeridos (`wrangler.jsonc`)

```jsonc
"rate_limiting": [
  {
    "binding": "RATE_LIMITER",
    "namespace_id": 1001,
    "simple": { "limit": 20, "period": 60 }
  }
]
```

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `RATE_LIMITER` | Rate Limiting | 20 req/IP/60s en todas las rutas `/api/*` |

## Estructura de archivos

```
src/
└── middleware/rateLimit.ts    # Middleware Hono: verifica RATE_LIMITER antes de cada handler
```

## Comportamiento

```typescript
// middleware/rateLimit.ts
const { success } = await env.RATE_LIMITER.limit({ key: clientIp })
if (!success) return c.json({ error: 'Demasiadas solicitudes' }, 429)
```

- **Clave**: IP del cliente (`CF-Connecting-IP` header).
- **En local dev**: Wrangler mockea el binding; siempre devuelve `{ success: true }`.
- **En develop**: `namespace_id: 1002` — contadores independientes del ambiente producción.

## Ajuste de límites

Actualizar `simple.limit` / `simple.period` en `wrangler.jsonc` y redesplegar. No requiere migraciones D1.

## Extensión por feature (Fase 2)

Para endpoints de alto costo (consolidación IA, generación PDF), agregar un rate limiter secundario con límite más bajo (p.e. 5 req/IP/60s) usando un namespace distinto.

## Checklist de implementación técnica

- [x] Binding `RATE_LIMITER` con `namespace_id: 1001` (prod) y `1002` (develop) en `wrangler.jsonc`
- [x] `src/middleware/rateLimit.ts` creado y aplicado globalmente en Hono
- [ ] Rate limiter secundario para endpoints de alto costo (consolidación IA, PDF) — Fase 2
