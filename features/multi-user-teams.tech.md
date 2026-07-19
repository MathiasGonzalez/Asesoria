# Tech Spec: Equipos y Roles Multi-usuario

## Stack

Worker Hono + D1. Extensión del middleware de autenticación existente.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `user_company_assignments`, `audit_log`; columna `role` en `users` |

## Estructura de archivos

```
src/
├── routes/team.ts              # GET/POST/PUT/DELETE /api/team/*
├── routes/audit.ts             # GET /api/audit-log
├── middleware/auth.ts          # Extendido: carga role + assignedCompanies
└── utils/permissions.ts       # requireRole(minRole), canAccessCompany()
```

## Esquema D1

Migración: `migrations/0010_teams.sql`

```sql
-- Agregar rol a users (ya existe la tabla)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'accountant';

CREATE TABLE user_company_assignments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  company_id   TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  assigned_by  TEXT,
  assigned_at  INTEGER,
  UNIQUE(user_id, company_id)
);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  ip_address  TEXT,
  metadata    TEXT,    -- JSON
  created_at  INTEGER
);
CREATE INDEX idx_audit_tenant_created ON audit_log(tenant_id, created_at DESC);
```

## Jerarquía de roles

```
owner > admin > senior > accountant > client
```

Implementado como enum ordenado en `utils/permissions.ts`:

```typescript
const ROLE_ORDER = ['client', 'accountant', 'senior', 'admin', 'owner'] as const
export type Role = typeof ROLE_ORDER[number]

export function requireRole(min: Role): MiddlewareHandler {
  return async (c, next) => {
    const userRole = c.get('user').role as Role
    if (ROLE_ORDER.indexOf(userRole) < ROLE_ORDER.indexOf(min))
      return c.json({ error: 'Forbidden' }, 403)
    await next()
  }
}
```

## Middleware extendido

Tras validar la sesión, el middleware carga el rol y las empresas asignadas en el contexto Hono:

```typescript
// middleware/auth.ts
const user = await getUser(env.DB, session.user_id)
const assignments = await getAssignedCompanies(env.DB, user.id)
c.set('user', { ...user, assignedCompanies: assignments.map(a => a.company_id) })
```

## Acceso a empresas

Los handlers de rutas como `/api/tax/periods` filtran por `company_id` si el usuario tiene rol `accountant`:

```typescript
const { user } = c.var
const filter = user.role === 'accountant'
  ? `AND company_id IN (${user.assignedCompanies.map(() => '?').join(',')})`
  : ''
```

## Feature flag

`teams_enabled` — cuando está deshabilitado, todos los usuarios actúan como `owner` (compatibilidad con tenants de un solo usuario).
