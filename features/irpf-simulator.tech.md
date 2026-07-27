# Tech Spec: Simulador IRPF y Calculadoras Fiscales

## Stack

Worker Hono + lógica pura TypeScript. Los endpoints de calculadoras son **públicos** (sin autenticación). No requiere D1 para las calculadoras base; opcionalmente D1 para guardar simulaciones de usuarios autenticados (Fase 2).

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| *(ninguno adicional)* | — | Las calculadoras son stateless |
| `DB` | D1 | (Fase 2) Tabla `saved_simulations` para usuarios autenticados |

## Estructura de archivos

```
src/
├── routes/calculators.ts          # POST /api/calculators/* (sin auth middleware)
├── services/tax-calculators.ts    # Lógica pura de cálculo
└── config/tax-tables.ts           # Parámetros fiscales versionados (BPC, escalas, cuotas)
```

## Configuración fiscal (`src/config/tax-tables.ts`)

Parámetros que se actualizan con cada ajuste DGI/BPS (típicamente enero de cada año):

```typescript
export const TAX_TABLES = {
  BPC_2025: 6_188,           // Unidad base para escalas IRPF
  IRPF_CAT2_BRACKETS: [
    { upToMultipleBpc: 7,   rate: 0    },
    { upToMultipleBpc: 10,  rate: 0.10 },
    { upToMultipleBpc: 15,  rate: 0.15 },
    { upToMultipleBpc: 50,  rate: 0.20 },
    { upToMultipleBpc: 75,  rate: 0.22 },
    { upToMultipleBpc: Infinity, rate: 0.25 },
  ],
  BPS_PERSONAL_JUBILACION: 0.15,
  BPS_PATRONAL_JUBILACION: 0.075,
  FONASA_LOW_THRESHOLD_BPC: 2.5,  // tasa baja debajo de este múltiplo de BPC
  FONASA_LOW_RATE:  0.03,
  FONASA_HIGH_RATE: 0.045,
  MONOTRIBUTO_A_MONTHLY: 4_200,   // cuota mensual categoría A (2025)
  MONOTRIBUTO_B_MONTHLY: 6_500,
  MONOTRIBUTO_LIMIT_ANNUAL: 920_000,
} as const
```

## Endpoints

Todos públicos (sin `Authorization`), protegidos solo por rate limiting:

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/calculators/irpf` | IRPF Cat. 2 anual |
| `POST` | `/api/calculators/monotributo` | Cuota + comparativa |
| `POST` | `/api/calculators/irae-comparison` | Régimen real vs pequeña empresa |
| `POST` | `/api/calculators/irnr` | IRNR (arrendamiento, dividendos) |
| `GET`  | `/api/calculators/tax-tables` | Tablas vigentes con `updatedAt` |

## Páginas frontend (Astro — públicas)

Las páginas en `/calculadoras/*` **no** usan `AppLayout.astro` (no requieren sesión). Usan `BaseLayout.astro` directamente para SEO y carga rápida.

```
web/pages/
└── calculadoras/
    ├── index.astro         # Hub de calculadoras
    ├── irpf.astro
    ├── monotributo.astro
    └── regimenes.astro
```

## Actualización de tablas fiscales

El archivo `src/config/tax-tables.ts` se actualiza manualmente en enero de cada año (o cuando hay decreto de ajuste). El endpoint `GET /api/calculators/tax-tables` expone `updatedAt` para que los clientes detecten cambios.

## Rate limiting diferenciado

Los endpoints de calculadoras usan el `RATE_LIMITER` estándar (20 req/IP/60s). No requieren rate limiter adicional dado que son stateless y de bajo costo computacional.

## Checklist de implementación técnica

- [ ] `src/services/tax-calculators.ts` creado con 4 funciones de cálculo
- [ ] `src/config/tax-tables.ts` creado con parámetros fiscales vigentes (BPC, escalas, cuotas)
- [ ] `src/routes/calculators.ts` creado con 5 endpoints públicos (sin auth)
- [ ] Endpoints verificados: no requieren `Authorization` header
- [ ] Páginas Astro en `web/pages/calculadoras/` creadas (públicas, sin `AppLayout`)
