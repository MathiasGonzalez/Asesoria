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
