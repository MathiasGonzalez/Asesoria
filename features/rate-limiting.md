# Rate Limiting

## Overview

Every `/api/*` request is subject to IP-based rate limiting via the **Cloudflare Workers Rate Limiting** binding (`RATE_LIMITER`). Requests that exceed the limit receive a `429 Too Many Requests` response.

## Configuration

Defined in `wrangler.jsonc`:

```jsonc
"rate_limiting": [
  {
    "binding": "RATE_LIMITER",
    "namespace_id": 1001,
    "simple": {
      "limit": 20,    // requests
      "period": 60    // seconds
    }
  }
]
```

The develop environment uses namespace `1002` so its counters are independent.

## Behaviour

| Dimension | Value |
|---|---|
| Key | Client IP (`CF-Connecting-IP` header) |
| Window | 60 seconds (sliding) |
| Limit | 20 requests / window |
| Response on limit | `429` + `{ "error": "Demasiadas solicitudes…" }` |

## Adjusting the Limit

Update `simple.limit` / `simple.period` in `wrangler.jsonc` and redeploy. No D1 migration needed.

## Local Development

Wrangler mocks the Rate Limiting binding locally. The mock always returns `{ success: true }`, so all requests pass during `wrangler dev`.

## Checklist de implementación

### Infraestructura
- [x] Binding `RATE_LIMITER` configurado en `wrangler.jsonc` con namespace `1001` (prod) y `1002` (develop)
- [x] Límite: 20 requests / 60 segundos por IP

### Backend
- [x] Middleware de rate limiting aplicado a todas las rutas `/api/*`
- [x] Respuesta `429 Too Many Requests` con mensaje en español al superar el límite

### Validación
- [x] Más de 20 requests en 60s desde la misma IP devuelven `429`
- [x] Request dentro del límite devuelve `200` normalmente
- [x] Entornos `prod` y `develop` tienen contadores independientes (namespaces distintos)
- [x] Mock local en `wrangler dev` siempre retorna `{ success: true }` (no bloquea desarrollo)
