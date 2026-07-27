# Fase 1 — Hardening de Tenant y Fundaciones

## Objetivo

Antes de agregar operaciones complejas (conciliación bancaria, agentes IA, open banking), la plataforma necesita un aislamiento de datos por tenant sólido, auditoría completa y gestión de cuotas. Esta fase no agrega features visibles para el usuario final, pero es el prerrequisito técnico y regulatorio de todo lo que sigue.

**Regulación que motiva esta fase:** Ley 18.331 (URCDP), Art. 47 Código Tributario (secreto tributario), BCU Circular 2352 (seguridad de sistemas financieros).

---

## Paso 1.1 — Aislamiento de datos por `tenant_id` en todos los modelos

### Problema actual

La tabla `tax_documents`, `tax_periods`, `companies` y otras usan `user_id` pero no siempre aplican el filtro `tenant_id` en las queries. Esto crea riesgo de que un usuario de un tenant acceda a datos de otro en edge cases.

### Solución

1. Agregar `tenant_id` como columna indexada en **todas** las tablas de negocio que no lo tengan.
2. En el middleware Hono, inyectar `tenant_id` desde la sesión y rechazar con `403` cualquier request cuyo `tenant_id` no coincida con el recurso solicitado.
3. Crear un helper `assertTenantOwnership(db, tenantId, table, resourceId)` reutilizable en todos los endpoints.
4. Migration: `0014_tenant_hardening.sql`

### Tablas a revisar

| Tabla | ¿Tiene `tenant_id`? | Acción |
|-------|-------------------|--------|
| `tax_periods` | Verificar | Agregar índice compuesto `(tenant_id, company_id)` |
| `tax_documents` | Verificar | Agregar índice compuesto `(tenant_id, period_id)` |
| `companies` | Verificar | Agregar índice |
| `employees` | Spec nueva | Incluir `tenant_id` desde el inicio |
| `bank_accounts` | Spec nueva | Incluir `tenant_id` desde el inicio |
| `cfe_configs` | Spec nueva | Incluir `tenant_id` |

### Estructura de claves R2 — corregir a tenant-first

```
# Antes (actual)
tax/{userId}/{periodId}/{uuid}/{filename}

# Después (con tenant_id)
tenants/{tenantId}/companies/{companyId}/periods/{periodId}/{uuid}/{filename}
```

Esto permite aplicar políticas de lifecycle (expiración, cuotas) a nivel tenant en R2.

---

## Paso 1.2 — Auditoría completa de acciones sensibles

### Problema actual

La tabla `audit_log` está especificada en `features/multi-user-teams.md` pero no está implementada. Sin ella, no hay trazabilidad de quién accedió a qué, requisito de la Ley 18.331.

### Solución

1. Implementar la tabla `audit_log` con migración `0015_audit_log.sql`.
2. Crear un helper `logAuditEvent(ctx, action, resourceType, resourceId, metadata?)` que escriba a D1 de forma asíncrona (usando `ctx.waitUntil`).
3. Instrumentar los siguientes eventos mínimos:

| Evento | `action` |
|--------|----------|
| Usuario accede a un documento | `document.read` |
| Usuario sube un documento | `document.upload` |
| Usuario ejecuta análisis IA | `analysis.run` |
| Usuario ejecuta conciliación | `reconciliation.run` |
| Admin revoca acceso de usuario | `user.revoke` |
| Se genera un reporte PDF | `report.generate` |
| Se comparte un informe con el cliente | `report.share` |
| Acceso a portal DGI/BPS en nombre de empresa | `portal.access` |

4. Endpoint `GET /api/audit-log` (solo `admin`/`owner`) con filtros: usuario, empresa, acción, rango de fechas.

### D1 Schema

```sql
-- migrations/0015_audit_log.sql
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  metadata    TEXT,           -- JSON
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_tenant_ts ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_user     ON audit_log(user_id, created_at DESC);
```

---

## Paso 1.3 — Cuotas de almacenamiento por tenant

### Problema actual

No hay límites por tenant en R2 ni en D1. Un tenant puede subir ilimitados archivos, lo cual es un riesgo operativo y de costos.

### Solución

1. Tabla `tenant_quotas` en D1:

```sql
CREATE TABLE tenant_quotas (
  tenant_id          TEXT PRIMARY KEY,
  storage_bytes_used INTEGER DEFAULT 0,
  storage_bytes_max  INTEGER DEFAULT 524288000,  -- 500 MB por defecto
  documents_count    INTEGER DEFAULT 0,
  documents_max      INTEGER DEFAULT 1000,
  updated_at         INTEGER
);
```

2. En cada upload a R2, actualizar `storage_bytes_used` con `file_size` y verificar límite antes de aceptar el archivo.
3. Feature Flag `storage_quota_enabled` para activar por tenant cuando sea necesario.
4. Exponer en la UI la barra de uso de almacenamiento (visible para `owner`/`admin`).

---

## Paso 1.4 — Aislamiento del corpus RAG por tenant

### Problema actual

Los embeddings en Vectorize son compartidos entre todos los tenants. La normativa DGI/BPS es pública y compartida, pero los documentos privados de empresas (planillas, facturas) no deberían poder ser recuperados en el contexto de otro tenant.

### Solución

1. Al ingestar documentos de empresa en Vectorize, incluir el metadata `{ tenant_id, company_id, doc_type: 'company' }`.
2. En todas las búsquedas vectoriales, aplicar el filtro `filter: { tenant_id: ctx.tenantId }` cuando el contexto sea de empresa.
3. Los documentos normativos (DGI/BPS) se etiquetan con `{ doc_type: 'normativa', public: true }` y no requieren filtro de tenant.

### Cloudflare Vectorize filter syntax

```typescript
const results = await env.VECTORIZE.query(embedding, {
  topK: 10,
  filter: {
    $or: [
      { doc_type: 'normativa' },
      { tenant_id: ctx.tenantId, doc_type: 'company' }
    ]
  }
})
```

---

## Paso 1.5 — Expiración y lifecycle de sesiones y OTPs

### Mejora

1. Agregar un Cloudflare Queue job que limpie periódicamente las sesiones expiradas y OTPs vencidos de D1.
2. Limitar a 3 OTP activos por email simultáneamente (prevención de abuso).
3. Registrar intentos fallidos de OTP en `audit_log` para detección de fuerza bruta.

---

## Entregables de la Fase 1

| Entregable | Descripción |
|------------|-------------|
| `migrations/0014_tenant_hardening.sql` | Índices compuestos con `tenant_id` |
| `migrations/0015_audit_log.sql` | Tabla `audit_log` |
| `migrations/0016_tenant_quotas.sql` | Tabla `tenant_quotas` |
| `src/middleware/tenant.ts` | Helper `assertTenantOwnership` |
| `src/middleware/audit.ts` | Helper `logAuditEvent` |
| `src/routes/audit.ts` | `GET /api/audit-log` |
| R2 key structure update | Claves con `tenantId` primero |
| Vectorize filter update | Filtros tenant en todas las búsquedas de empresa |

---

## Impacto en compliance

| Regulación | Cómo lo cubre esta fase |
|------------|------------------------|
| Ley 18.331 Art. 11 (seguridad) | Aislamiento completo de datos por organización |
| Ley 18.331 Art. 13 (deber de secreto) | Audit log de todos los accesos a datos personales |
| Art. 47 Código Tributario | Filtros tenant impiden que información fiscal cruce entre clientes |
| BCU Circular 2352 (banca futura) | Prerequisito de trazabilidad para operar como proveedor de servicios financieros |

---

## Checklist de implementación

### Paso 1.1 — Aislamiento tenant_id
- [ ] Auditar todas las tablas de negocio: verificar presencia de `tenant_id`
- [ ] Migración `migrations/0014_tenant_hardening.sql`: agregar índices compuestos `(tenant_id, *)` faltantes
- [ ] Helper `assertTenantOwnership(db, tenantId, table, resourceId)` creado en `src/middleware/tenant.ts`
- [ ] Middleware Hono extendido: inyecta `tenant_id` desde sesión y llama `assertTenantOwnership` en todos los endpoints con recursos por ID
- [ ] Estructura de claves R2 migrada a `tenants/{tenantId}/companies/{companyId}/periods/{periodId}/{uuid}/{filename}`
- [ ] Scripts de migración de claves R2 existentes a la nueva estructura ejecutados

### Paso 1.2 — Audit Log
- [ ] Migración `migrations/0015_audit_log.sql` aplicada
- [ ] Helper `logAuditEvent(ctx, action, resourceType, resourceId, metadata?)` creado en `src/middleware/audit.ts`
- [ ] Eventos instrumentados: `document.read`, `document.upload`, `analysis.run`, `reconciliation.run`, `user.revoke`, `report.generate`, `report.share`, `portal.access`
- [ ] `GET /api/audit-log` con filtros (usuario, empresa, acción, rango de fechas) implementado
- [ ] Endpoint protegido con `requireRole('admin')` o `requireRole('owner')`

### Paso 1.3 — Cuotas de almacenamiento
- [ ] Migración `migrations/0016_tenant_quotas.sql` aplicada
- [ ] Verificación de cuota ejecutada antes de cada upload a R2
- [ ] Actualización de `storage_bytes_used` en `tenant_quotas` tras cada upload exitoso
- [ ] Feature flag `storage_quota_enabled` creado (desactivado por defecto)
- [ ] Barra de uso de almacenamiento visible para `owner`/`admin` en settings

### Paso 1.4 — Aislamiento corpus Vectorize
- [ ] Ingestión de documentos de empresa agrega metadata `{ tenant_id, company_id, doc_type: 'company' }`
- [ ] Documentos normativos etiquetados con `{ doc_type: 'normativa', public: true }`
- [ ] Todas las búsquedas Vectorize de empresa aplican filtro `{ tenant_id: ctx.tenantId }` o `{ doc_type: 'normativa' }`
- [ ] Test: consulta de un tenant no recupera embeddings de otro tenant

### Paso 1.5 — Lifecycle de sesiones y OTPs
- [ ] Cloudflare Queue job para limpiar sesiones expiradas y OTPs vencidos periódicamente
- [ ] Límite de 3 OTPs activos por email a la vez
- [ ] Intentos fallidos de OTP registrados en `audit_log` para detección de fuerza bruta
