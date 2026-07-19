# Feature: Conciliación Bancaria Automatizada (Bank Reconciliation)

## Descripción

Módulo de conciliación bancaria que permite importar extractos bancarios (BROU, Itaú, Santander, Scotiabank), categorizarlos automáticamente con IA y cruzarlos contra los movimientos registrados en el período fiscal, identificando diferencias, duplicados y transacciones no contabilizadas.

## Casuística de mercado

La conciliación bancaria es uno de los procesos más **tediosos y propensos a errores** en contabilidad:

- Toda empresa con actividad bancaria debe conciliar mensualmente sus cuentas para el cierre fiscal.
- Hoy el proceso es 100% manual: descargar el extracto del banco, copiar a Excel, comparar línea a línea.
- Empresas con alta rotación (comercios, restaurantes) tienen 200–500 movimientos mensuales para conciliar.
- Los bancos uruguayos no tienen APIs abiertas; el estándar es OFX/CSV descargado manualmente.
- Los errores de conciliación son causa frecuente de diferencias en el IVA y el balance mensual.
- La IA puede categorizar transacciones bancarias con >85% de precisión tras aprender los patrones del negocio.

## Casos de uso

- **UC-130** Un contador importa el extracto bancario de su cliente en formato CSV desde el BROU. El sistema detecta 287 movimientos, los categoriza automáticamente (cobros de clientes, pagos a proveedores, sueldos, impuestos) y marca 12 transacciones como "no identificadas" para revisión manual.
- **UC-131** El sistema cruza los movimientos bancarios contra los CFEs emitidos en el mes y marca qué facturas fueron efectivamente cobradas y cuáles siguen pendientes de pago.
- **UC-132** Al ejecutar la conciliación, el sistema detecta un débito automático de impuesto patrimonial que no estaba en el libro contable y alerta al contador.
- **UC-133** El resultado de la conciliación se exporta como un resumen e ingesta automáticamente en el período fiscal como documento `resumen_bancario`, listo para el análisis IA.
- **UC-134** La IA aprende las categorizaciones del contador: si siempre categoriza pagos a "Antel" como "servicios de telecomunicaciones", la próxima vez lo hace automáticamente.

## Formatos de extracto soportados

| Banco | Formato disponible |
|-------|--------------------|
| BROU | CSV / XLS exportado del portal |
| Itaú Uruguay | CSV exportado del home banking |
| Santander Uruguay | CSV / OFX |
| Scotiabank Uruguay | CSV |
| HSBC / Citibank | OFX / MT940 |
| Genérico | OFX estándar (cualquier banco) |

## Categorías de transacciones

```
Ingresos:
  cobro_cliente      Cobros de facturas a clientes
  deposito_efectivo  Depósitos en efectivo
  transferencia_in   Transferencias entrantes
  devolucion_impuesto Devoluciones DGI/BPS

Egresos:
  pago_proveedor     Pagos a proveedores
  impuesto_dgi       Pagos a DGI (IVA, IRAE, IRPF)
  impuesto_bps       Pagos a BPS
  sueldos            Pago de nómina
  alquiler           Pago de arrendamiento
  servicio           Servicios (luz, agua, telefonía)
  banco_comision     Comisiones bancarias
  prestamo           Cuotas de préstamos

Sin clasificar:
  desconocido        Requiere revisión manual
```

## Modelo de datos

```sql
bank_accounts (
  id, user_id, tenant_id, company_id,
  banco         TEXT,
  numero_cuenta TEXT,
  moneda        TEXT DEFAULT 'UYU',
  alias         TEXT,
  created_at
)

bank_statements (
  id, account_id, user_id, tenant_id,
  period_month  INTEGER,
  period_year   INTEGER,
  filename      TEXT,
  status        TEXT,   -- imported | categorized | reconciled
  total_credits REAL,
  total_debits  REAL,
  balance_open  REAL,
  balance_close REAL,
  imported_at   TIMESTAMP
)

bank_transactions (
  id, statement_id, account_id,
  fecha         DATE,
  descripcion   TEXT,
  monto         REAL,
  tipo          TEXT,   -- credito | debito
  categoria     TEXT,
  categoria_ia  TEXT,   -- categoría sugerida por IA
  confianza_ia  REAL,   -- score 0-1
  conciliado    INTEGER DEFAULT 0,
  cfe_id        TEXT,   -- FK a cfe_documents si corresponde
  notas         TEXT
)

reconciliation_reports (
  id, statement_id, period_id,
  total_conciliados   INTEGER,
  total_diferencias   INTEGER,
  monto_diferencias   REAL,
  detalle_json        TEXT,
  generated_at        TIMESTAMP
)
```

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`    | `/api/bank/accounts` | Lista cuentas bancarias del usuario |
| `POST`   | `/api/bank/accounts` | Registra cuenta bancaria |
| `POST`   | `/api/bank/statements/import` | Importa extracto (multipart CSV/OFX) |
| `GET`    | `/api/bank/statements` | Lista extractos importados |
| `GET`    | `/api/bank/statements/:id/transactions` | Lista transacciones del extracto |
| `PUT`    | `/api/bank/transactions/:id/categorize` | Corrige categoría de una transacción |
| `POST`   | `/api/bank/statements/:id/reconcile` | Ejecuta conciliación contra CFEs del período |
| `GET`    | `/api/bank/statements/:id/report` | Descarga reporte de conciliación |
| `POST`   | `/api/bank/statements/:id/ingest` | Ingesta resumen en el período fiscal |

## Flujo de categorización con IA

```
Extracto importado (CSV/OFX parseado)
  → por cada transacción:
    → workers AI (llama-3-8b-instruct)
      → "Clasificá esta transacción bancaria uruguaya en una categoría contable:
         Descripción: '{descripcion}', Monto: ${monto}, Tipo: {credito|debito}"
    → almacena categoria_ia + confianza_ia
  → transacciones con confianza < 0.7 → marcadas como "revisar"
  → contador confirma/corrige → se retroalimenta para futuras importaciones
```

## Páginas

- `/app/conciliacion` — Lista de extractos importados por empresa
- `/app/conciliacion/:statementId` — Tabla interactiva de transacciones con categorías editables
- `/app/conciliacion/:statementId/reporte` — Resumen de conciliación y diferencias detectadas

## Mejoras futuras (v2)

- Conexión directa vía scraping autorizado o open banking (cuando esté disponible en UY)
- Reconocimiento automático de facturas en el extracto por monto + fecha (matching con CFEs)
- Detección de gastos duplicados (mismo monto, misma descripción, días seguidos)
- Informe de flujo de caja mensual generado automáticamente desde el extracto conciliado
- Soporte multi-moneda con tipo de cambio BCU automático para cuentas en USD
