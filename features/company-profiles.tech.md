# Tech Spec: Company Profiles

## Stack

Worker Hono + D1. No requiere bindings adicionales.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tabla `companies` |

## Estructura de archivos

```
src/
└── routes/companies.ts    # GET/POST/PUT/DELETE /api/companies
```

## Esquema D1

Migración: `migrations/0006_companies.sql`

```sql
CREATE TABLE companies (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  rut              TEXT NOT NULL,
  razon_social     TEXT NOT NULL,
  nombre_comercial TEXT,
  tipo_entidad     TEXT,
  regimen_irae     TEXT,
  actividad        TEXT,
  bps_nro_patronal TEXT,
  domicilio_fiscal TEXT,
  created_at       INTEGER,
  updated_at       INTEGER,
  UNIQUE(user_id, rut)
);
```

## Validación de RUT

La normalización y validación del RUT se implementa como función utilitaria compartida:

```typescript
// src/utils/rut.ts
export function normalizeRut(rut: string): string {
  return rut.replace(/[\.\-\s]/g, '')
}
export function validateRut(rut: string): boolean {
  const normalized = normalizeRut(rut)
  return /^\d{12}$/.test(normalized)
}
```

La validación del **dígito verificador** (algoritmo DGI) se implementa en Fase 2.

## Integración con Tax Analysis

El `company_id` en `tax_periods` se resuelve a los datos completos de la empresa al construir el prompt de consolidación IA. El servicio `tax-consolidation.ts` hace un JOIN implícito antes de llamar a Workers AI.
