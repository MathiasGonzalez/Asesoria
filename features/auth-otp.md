# OTP Authentication & Multi-Tenancy

## Overview

Authentication is passwordless. Users receive a one-time 6-digit code at their email address; on first login a **tenant** is automatically created from their email domain.

## Flow

```
1. User enters email → POST /api/auth/request-otp
2. Worker generates 6-digit OTP, stores in D1 (expires in 10 min), sends email via Resend
3. User enters code → POST /api/auth/verify-otp
4. Worker validates code; if new email → creates tenant + user row in D1
5. Worker creates session (UUID, 24 h TTL) stored in D1
6. Session token returned to client, stored in localStorage
7. All /api/search and /api/ingest calls include the `Authorization` header with the session token
8. Middleware validates token against sessions table on every request
```

## Tenant Model

| First login | Creates `tenants` row (name = email domain) + `users` row |
|---|---|
| Subsequent logins | Looks up existing user by email, creates new session |

Each tenant gets isolated feature flag overrides. The RAG corpus is currently shared across tenants; per-tenant isolation can be added by filtering documents by `tenant_id`.

## DB Schema (migration `0001_auth.sql`)

| Table | Purpose |
|---|---|
| `tenants` | One row per organisation / email domain |
| `users` | One row per verified email, linked to a tenant |
| `otp_codes` | Short-lived codes; invalidated after use or expiry |
| `sessions` | Active sessions; 24 h TTL; deleted on logout |

## Security Notes

- OTPs are single-use and expire in 10 minutes.
- Requesting a new OTP invalidates all previous unused codes for that email.
- Sessions are server-side UUIDs (not JWTs); revocable via `DELETE FROM sessions`.
- **Production upgrade path:** replace `localStorage` sessions with Cloudflare Access (Zero Trust) for SSO and hardware-key support.

## Email Provider Setup (Resend)

1. Sign up at [resend.com](https://resend.com) and create an API key.
2. Verify your sending domain via DNS.
3. Set Worker secrets:
   ```sh
   wrangler secret put EMAIL_API_KEY   # re:...
   wrangler secret put EMAIL_FROM      # noreply@yourdomain.com
   # For develop environment:
   wrangler secret put EMAIL_API_KEY --env develop
   wrangler secret put EMAIL_FROM     --env develop
   ```
