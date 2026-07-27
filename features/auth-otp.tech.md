# Tech Spec: OTP Auth + Multi-Tenancy

## Stack

100% dentro del Worker Hono + D1. No requiere bindings adicionales.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `tenants`, `users`, `otp_codes`, `sessions` |
| `EMAIL_SEND` | Send Email | Envío del código OTP |

### Secrets

| Secret | Descripción |
|--------|-------------|
| `EMAIL_FROM` | Dirección verificada de envío, e.g. `noreply@adviser.uy` |
| `EMAIL_API_KEY` | Resend API key (fallback si `EMAIL_SEND` no está disponible) |

## Estructura de archivos

```
src/
├── routes/auth.ts          # POST /api/auth/request-otp, /verify-otp, /logout
├── middleware/auth.ts       # Valida sesión en cada request protegido
└── services/email.ts        # Abstracción Email_Send / Resend fallback
```

## Esquema D1

Migración: `migrations/0001_auth.sql`

```sql
CREATE TABLE tenants  (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER);
CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT UNIQUE, role TEXT DEFAULT 'accountant', created_at INTEGER);
CREATE TABLE otp_codes(id TEXT PRIMARY KEY, email TEXT, code TEXT, expires_at INTEGER, used INTEGER DEFAULT 0);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, created_at INTEGER, expires_at INTEGER);
```

## Consideraciones

- Las sesiones tienen TTL de 24 h; `expires_at` se evalúa en el middleware.
- El OTP se invalida tras el primer uso o al solicitar uno nuevo.
- El campo `role` en `users` es extensible para la feature `multi-user-teams`.

## Checklist de implementación técnica

- [x] Migración `migrations/0001_auth.sql` aplicada
- [x] `src/routes/auth.ts` creado con los 3 endpoints
- [x] `src/middleware/auth.ts` creado y aplicado en Hono
- [x] `src/services/email.ts` creado con abstracción Email_Send / Resend fallback
- [x] Bindings `DB`, `EMAIL_SEND` en `wrangler.jsonc`
- [x] Worker Secrets `EMAIL_FROM`, `EMAIL_API_KEY` configurados en prod y develop
