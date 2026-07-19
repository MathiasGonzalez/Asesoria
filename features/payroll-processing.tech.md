# Tech Spec: Liquidación de Sueldos (Payroll Processing)

## Stack

Worker Hono + D1 + **FluentReport Container** ([MathiasGonzalez/FluentReport](https://github.com/MathiasGonzalez/FluentReport)) — Cloudflare Containers (.NET 10). Los recibos de sueldo y el archivo SUNA se generan como PDF/CSV en el Container.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `employees`, `payroll_periods`, `payroll_items` |
| `DOCUMENTS_BUCKET` | R2 | Archivos SUNA y PDFs de recibos generados |
| `REPORT_CONTAINER` | Container DO | FluentReport API para recibos de sueldo PDF |

> El binding `REPORT_CONTAINER` es **compartido** con Tax Analysis, Client Portal y Bank Reconciliation. Ver `features/fluentreport-container.tech.md` para la configuración completa.

## FluentReport Container — recibo de sueldo PDF

```typescript
// src/services/reports.ts
export async function renderPayslipPdf(
  env: Env,
  item: PayrollItem,
  employee: Employee,
  company: Company,
  period: { month: number; year: number }
): Promise<Uint8Array> {
  const container = getContainer(env.REPORT_CONTAINER, 'default')
  const res = await container.fetch('http://internal/render/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayslipSchema({ item, employee, company, period }))
  })
  return new Uint8Array(await res.arrayBuffer())
}
```

El schema del recibo de sueldo sigue el formato de FluentReport.Schema (YAML/JSON). FluentReport incluye muestras de documentos fiscales uruguayos en [`docs/uy-fiscal-samples.md`](https://github.com/MathiasGonzalez/FluentReport/blob/main/docs/uy-fiscal-samples.md) que incluyen un modelo de recibo de sueldo.

## Estructura de archivos

```
src/
├── routes/payroll.ts                # Todos los endpoints /api/payroll/*
├── services/payroll-calculator.ts   # Cálculo puro: IRPF, BPS, FONASA, FRL
├── services/suna-exporter.ts        # Generación del archivo SUNA (TXT/CSV)
├── services/reports.ts              # FluentReport Container (compartido)
└── config/payroll-tables.ts         # Escalas BPS/IRPF versionadas
```

## Esquema D1

Migración: `migrations/0015_payroll.sql`

```sql
CREATE TABLE employees (
  id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, company_id TEXT,
  nombre TEXT NOT NULL, cedula TEXT,
  fecha_ingreso TEXT, cargo TEXT,
  salario_nominal REAL NOT NULL,
  categoria_bps TEXT DEFAULT 'dependiente',
  sindicato TEXT, activo INTEGER DEFAULT 1,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_employees_company ON employees(company_id, activo);

CREATE TABLE payroll_periods (
  id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, company_id TEXT,
  month INTEGER NOT NULL, year INTEGER NOT NULL,
  status TEXT DEFAULT 'draft',  -- draft | calculated | closed
  created_at INTEGER,
  UNIQUE(company_id, month, year)
);

CREATE TABLE payroll_items (
  id TEXT PRIMARY KEY, period_id TEXT, employee_id TEXT,
  salario_nominal REAL, horas_extra REAL DEFAULT 0,
  complementos REAL DEFAULT 0, total_bruto REAL,
  irpf REAL, bps_personal REAL, fonasa REAL, frl REAL,
  sindicato REAL DEFAULT 0, otras_deducciones REAL DEFAULT 0,
  liquido REAL, bps_patronal REAL,
  detalle_json TEXT,  -- desglose completo para auditoría
  generated_at INTEGER
);
```

## Lógica de cálculo (`src/services/payroll-calculator.ts`)

Cálculo puro TypeScript con las tablas fiscales de `src/config/payroll-tables.ts`:

```typescript
export function calculatePayroll(
  employee: Employee,
  extras: number,
  complements: number,
  tables: PayrollTables
): PayrollItem

// Ejemplo de uso en el route handler:
const items = period.employees.map(e =>
  calculatePayroll(e, e.horasExtra ?? 0, e.complementos ?? 0, PAYROLL_TABLES_2025)
)
```

### Orden de cálculo

1. `total_bruto = salario_nominal + horas_extra + complementos`
2. `bps_personal = total_bruto × BPS_PERSONAL_JUBILACION` (15%)
3. `fonasa = total_bruto × (tasa baja o alta según tramo BPC)`
4. `frl = total_bruto × 0.001` (0.1%)
5. `base_irpf = total_bruto - bps_personal - fonasa - frl`
6. `irpf = aplicar_tramos_irpf(base_irpf, BPC_vigente)`
7. `liquido = total_bruto - irpf - bps_personal - fonasa - frl - sindicato`
8. `bps_patronal = total_bruto × BPS_PATRONAL_TOTAL` (~12.65%)

## Generación de archivo SUNA

El archivo SUNA es un TXT con formato fijo definido por BPS. Se genera en el Worker (sin necesidad de FluentReport) y se descarga directamente:

```
GET /api/payroll/periods/:id/suna
Content-Disposition: attachment; filename="suna_YYYYMM.txt"
```

## Feature flag

`payroll_enabled` — protege todos los endpoints `/api/payroll/*`.
