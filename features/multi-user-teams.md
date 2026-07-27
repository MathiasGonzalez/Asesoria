# Feature: Equipos y Roles Multi-Usuario (Multi-User Teams)

## Descripción

Sistema de gestión de usuarios dentro de un tenant que permite a estudios contables crear equipos con roles diferenciados: administradores, contadores senior, auxiliares y clientes. Cada rol tiene permisos granulares sobre qué puede ver, crear, ejecutar y aprobar dentro de la plataforma.

## Casuística de mercado

La gran mayoría de estudios contables uruguayos trabaja en equipo:

- Un estudio mediano tiene 2–8 contadores, donde el titular revisa el trabajo de los auxiliares.
- Hoy, en sistemas sin roles, todos acceden con la misma cuenta o se comparten contraseñas — riesgo de seguridad y sin trazabilidad.
- Los auxiliares no deberían poder ejecutar consolidaciones IA ni aprobar análisis sin supervisión del titular.
- Los clientes del portal necesitan una cuenta propia pero con acceso estrictamente limitado a su empresa.
- La regulación uruguaya (Ley 18.331) exige que el acceso a datos personales esté restringido al mínimo necesario.

## Casos de uso

- **UC-100** El titular del estudio crea cuentas para sus 3 auxiliares con rol `accountant`. Cada uno solo ve los clientes que le fueron asignados.
- **UC-101** Un auxiliar sube documentos y ejecuta el análisis de IA para su cliente asignado, pero no puede cerrar el período ni compartir el informe — esa acción requiere rol `senior` o `admin`.
- **UC-102** El administrador ve un log de auditoría: quién ejecutó cada análisis, qué documentos subió cada usuario y cuándo.
- **UC-103** Se revoca el acceso de un auxiliar que dejó el estudio con un solo click; todas sus sesiones activas se invalidan inmediatamente.
- **UC-104** Un cliente del portal accede a su espacio con su propio email, sin ver datos de otros clientes del estudio.

## Roles del sistema

| Rol | Descripción | Permisos clave |
|-----|-------------|---------------|
| `owner` | Titular del tenant | Todo. No puede ser revocado. |
| `admin` | Administrador delegado | Gestión de usuarios, configuración, todos los clientes |
| `senior` | Contador senior | Crear/cerrar períodos, compartir informes, ejecutar consolidaciones |
| `accountant` | Contador / auxiliar | Ver y subir documentos en clientes asignados; ejecutar análisis |
| `client` | Cliente del estudio | Solo su empresa: subir documentos solicitados, ver sus informes |

## Matriz de permisos

| Acción | owner | admin | senior | accountant | client |
|--------|-------|-------|--------|------------|--------|
| Ver todos los clientes | ✅ | ✅ | ✅ | ❌ (solo asignados) | ❌ |
| Crear/editar empresas | ✅ | ✅ | ✅ | ❌ | ❌ |
| Subir documentos | ✅ | ✅ | ✅ | ✅ | ✅ (propios) |
| Ejecutar análisis IA | ✅ | ✅ | ✅ | ✅ | ❌ |
| Cerrar período | ✅ | ✅ | ✅ | ❌ | ❌ |
| Compartir informe | ✅ | ✅ | ✅ | ❌ | ❌ |
| Invitar usuarios | ✅ | ✅ | ❌ | ❌ | ❌ |
| Ver log de auditoría | ✅ | ✅ | ❌ | ❌ | ❌ |
| Ingestar documentos normativos | ✅ | ✅ | ❌ | ❌ | ❌ |

## Modelo de datos

```sql
-- Extensión de la tabla users existente
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'accountant';
-- Valores: owner | admin | senior | accountant | client

-- Asignación de clientes a contadores
user_company_assignments (
  id, user_id, company_id, tenant_id,
  assigned_by  TEXT,
  assigned_at  TIMESTAMP
)

-- Log de auditoría
audit_log (
  id, tenant_id, user_id,
  action       TEXT,    -- create_period | run_analysis | upload_doc | share_report | etc.
  resource     TEXT,    -- nombre del recurso afectado
  resource_id  TEXT,
  ip_address   TEXT,
  metadata     TEXT,    -- JSON con detalles adicionales
  created_at   TIMESTAMP
)
```

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`    | `/api/team/members` | Lista usuarios del tenant con su rol |
| `POST`   | `/api/team/invite` | Invita un nuevo miembro (envía OTP) |
| `PUT`    | `/api/team/members/:id/role` | Cambia el rol de un miembro |
| `DELETE` | `/api/team/members/:id` | Revoca acceso (invalida sesiones activas) |
| `GET`    | `/api/team/members/:id/assignments` | Lista empresas asignadas al miembro |
| `POST`   | `/api/team/members/:id/assign` | Asigna empresa a un contador |
| `DELETE` | `/api/team/members/:id/assign/:companyId` | Desasigna empresa |
| `GET`    | `/api/audit-log` | Consulta log de auditoría (solo admin/owner) |

## Integración con el middleware existente

El middleware de autenticación actual (`src/middleware/auth.ts`) se extiende para:

1. Cargar el rol del usuario desde D1 tras validar la sesión.
2. Inyectar `user.role` y `user.assignedCompanies` en el contexto Hono.
3. Proveer un helper `requireRole(minRole)` que rechaza con 403 si el rol es insuficiente.

```typescript
// Ejemplo de uso en un endpoint
app.post('/api/tax/periods/:id/consolidate', requireRole('accountant'), async (c) => { ... })
app.post('/api/portal/share', requireRole('senior'), async (c) => { ... })
```

## Páginas

- `/app/equipo` — Lista de miembros del equipo con badges de rol y acciones (solo admin/owner)
- `/app/equipo/log` — Log de auditoría filtrable por usuario, acción y fecha (solo admin/owner)

## Mejoras futuras (v2)

- Notificaciones al titular cuando un auxiliar completa un análisis para revisión
- Límite de clientes activos por plan de suscripción (billing feature gate)
- SSO corporativo vía Cloudflare Access (ZT) para estudios grandes
- Roles personalizados con permisos ad-hoc configurables por el admin

## Checklist de implementación

### Base de datos
- [ ] Migración: `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'accountant'`
- [ ] Tabla `user_company_assignments` creada con índices
- [ ] Tabla `audit_log` creada con índices `(tenant_id, created_at DESC)` y `(user_id, created_at DESC)`

### Backend
- [ ] `GET /api/team/members` — lista usuarios del tenant con su rol
- [ ] `POST /api/team/invite` — invita nuevo miembro (envía OTP de bienvenida)
- [ ] `PUT /api/team/members/:id/role` — cambia rol (solo `admin`/`owner`)
- [ ] `DELETE /api/team/members/:id` — revoca acceso e invalida sesiones activas
- [ ] `GET /api/team/members/:id/assignments` — lista empresas asignadas
- [ ] `POST /api/team/members/:id/assign` — asigna empresa a contador
- [ ] `DELETE /api/team/members/:id/assign/:companyId` — desasigna empresa
- [ ] `GET /api/audit-log` — consulta log (solo `admin`/`owner`, con filtros)
- [ ] Middleware extendido: carga `user.role` y `user.assignedCompanies` en contexto Hono
- [ ] Helper `requireRole(minRole)` implementado y usado en endpoints existentes
- [ ] Acceso a empresa de `accountant` limitado a `assignedCompanies`

### Frontend
- [ ] `/app/equipo` — lista de miembros del equipo con badges de rol y acciones
- [ ] `/app/equipo/log` — log de auditoría filtrable por usuario, acción y fecha

### Validación
- [ ] UC-100: auxiliar solo ve clientes asignados, no todos
- [ ] UC-101: auxiliar no puede cerrar período ni compartir informe
- [ ] UC-102: admin ve log de auditoría completo
- [ ] UC-103: revocar acceso invalida sesiones activas inmediatamente
- [ ] UC-104: cliente del portal solo ve su empresa
