# Tech Spec: Conciliación Bancaria Automatizada

## Stack

Worker Hono + D1 + R2 + Workers AI (categorización) + **FluentReport Container** (Cloudflare Containers, .NET 10) para el reporte PDF de conciliación.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `bank_accounts`, `bank_statements`, `bank_transactions`, `reconciliation_reports` |
| `DOCUMENTS_BUCKET` | R2 | Archivos de extracto originales (CSV/OFX) |
| `AI` | Workers AI | `llama-3-8b-instruct` para categorización automática |
| `REPORT_CONTAINER` | Container DO | FluentReport API para generar reporte PDF de conciliación |

## FluentReport Container — reporte PDF

El endpoint `GET /api/bank/statements/:id/report` genera el reporte de conciliación como PDF usando el Container de FluentReport:

```typescript
// src/services/reports.ts
export async function renderReconciliationReport(
  env: Env,
  statement: BankStatement,
  transactions: BankTransaction[],
  differences: Difference[]
): Promise<Uint8Array> {
  const container = getContainer(env.REPORT_CONTAINER, 'default')
  const res = await container.fetch('http://internal/render/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildReconciliationSchema({ statement, transactions, differences }))
  })
  return new Uint8Array(await res.arrayBuffer())
}
```

> Ver `features/fluentreport-container.tech.md` para la configuración completa del Container compartido.

## Estructura de archivos

```
src/
├── routes/bank.ts                    # Todos los endpoints /api/bank/*
├── services/bank-parser.ts           # Parseo CSV/OFX → BankTransaction[]
├── services/bank-categorizer.ts      # Workers AI categorización
├── services/bank-reconciler.ts       # Cruce contra CFEs del período
└── services/reports.ts               # FluentReport Container (compartido)
```

## Esquema D1

Migración: `migrations/0013_bank.sql`

```sql
CREATE TABLE bank_accounts (
  id TEXT PRIMARY KEY, user_id TEXT, tenant_id TEXT, company_id TEXT,
  banco TEXT, numero_cuenta TEXT, moneda TEXT DEFAULT 'UYU', alias TEXT, created_at INTEGER
);

CREATE TABLE bank_statements (
  id TEXT PRIMARY KEY, account_id TEXT, user_id TEXT, tenant_id TEXT,
  period_month INTEGER, period_year INTEGER, filename TEXT, r2_key TEXT,
  status TEXT DEFAULT 'imported', total_credits REAL, total_debits REAL,
  balance_open REAL, balance_close REAL, imported_at INTEGER
);

CREATE TABLE bank_transactions (
  id TEXT PRIMARY KEY, statement_id TEXT, account_id TEXT,
  fecha TEXT, descripcion TEXT, monto REAL, tipo TEXT,
  categoria TEXT, categoria_ia TEXT, confianza_ia REAL,
  conciliado INTEGER DEFAULT 0, cfe_id TEXT, notas TEXT
);
CREATE INDEX idx_bank_tx_statement ON bank_transactions(statement_id);

CREATE TABLE reconciliation_reports (
  id TEXT PRIMARY KEY, statement_id TEXT, period_id TEXT,
  total_conciliados INTEGER, total_diferencias INTEGER,
  monto_diferencias REAL, detalle_json TEXT, generated_at INTEGER
);
```

## Flujo de categorización IA

```typescript
// services/bank-categorizer.ts
const prompt = `Clasificá esta transacción bancaria uruguaya en una de estas categorías:
cobro_cliente | pago_proveedor | impuesto_dgi | impuesto_bps | sueldos |
alquiler | servicio | banco_comision | prestamo | deposito_efectivo |
transferencia_in | devolucion_impuesto | desconocido

Descripción: "${tx.descripcion}", Monto: ${tx.monto}, Tipo: ${tx.tipo}
Responde SOLO con el nombre de la categoría y un número de confianza (0.0-1.0) separados por coma.`

const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', { prompt })
// Parsea "pago_proveedor,0.92"
```

Transacciones con `confianza_ia < 0.70` se marcan como `desconocido` y requieren revisión manual.

## Parseo de formatos bancarios

| Banco | Formato | Parser |
|-------|---------|--------|
| BROU, Itaú, Santander | CSV | `bank-parser.ts` con detección automática de columnas |
| Scotiabank | CSV | Ídem |
| Genérico | OFX | Parser OFX (XML) incluido en `bank-parser.ts` |

## Feature flag

`bank_reconciliation_enabled` — protege todos los endpoints `/api/bank/*`.
