# Tech Spec: Fiscal Calendar

## Stack

Worker Hono + lógica pura TypeScript. Sin bindings adicionales para el calendario base. Cuando se integre con notificaciones, usará `DB` para leer `companies` (dígito de RUT para personalizar vencimientos).

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | (Fase 2) Leer dígito de RUT de `companies` para ajustar vencimientos personalizados |

## Estructura de archivos

```
src/
├── routes/calendar.ts         # GET /api/calendar?year=&month=
└── services/fiscal-calendar.ts  # Cálculo puro de vencimientos
```

## Lógica de vencimientos

Las fechas son **stateless** — se calculan en tiempo de request sin persistencia:

```typescript
// src/services/fiscal-calendar.ts
export function getMonthlyDueDates(year: number, month: number): DueDate[]
export function getAnnualDueDates(year: number): DueDate[]
export function adjustForWeekend(date: Date): Date   // siguiente hábil si cae sábado/domingo
```

Los parámetros (días de vencimiento por tipo de impuesto) se mantienen en `src/config/fiscal-rules.ts` y se actualizan manualmente cuando DGI/BPS modifica el calendario oficial.

## Página frontend

`/app/calendario` — Astro page que llama a `GET /api/calendar` y renderiza el resultado con Tailwind. No requiere estado del lado del cliente más allá del año seleccionado.

## Extensión Fase 2: vencimiento personalizado por RUT

El dígito final del RUT determina el día exacto de vencimiento de IVA/IRAE para CEDE. La extensión lee el `rut` de `companies` y ajusta las fechas antes de devolver la respuesta.

## Checklist de implementación técnica

- [x] `src/routes/calendar.ts` creado con `GET /api/calendar`
- [x] `src/services/fiscal-calendar.ts` creado con lógica pura de vencimientos
- [x] `src/config/fiscal-rules.ts` creado con parámetros de DGI/BPS
- [x] `adjustForWeekend()` implementado para mover vencimientos al siguiente día hábil
- [ ] Vencimiento personalizado por dígito de RUT (requiere leer `companies` — Fase 2)
