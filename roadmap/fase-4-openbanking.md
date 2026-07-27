# Fase 4 — Capa Bancaria y Preparación Fintech

## Objetivo

Construir la capa de manejo de cuentas bancarias en tres etapas progresivas, alineadas al estado real del mercado uruguayo: desde importación manual hoy hasta open banking vía API cuando la regulación BCU lo permita.

**Marco regulatorio:** Ley 19.210 (Inclusión Financiera), Ley 18.838 (Sistema de Pagos del Uruguay), Ley 19.574 (Lavado de Activos / UAFIU), BCU Circular 2395 (SIPAP), Marco Open Banking BCU (en desarrollo, 2025).

---

## Estado del mercado bancario uruguayo (2025)

| Dimensión | Estado actual |
|-----------|--------------|
| APIs bancarias abiertas | **No existen** aún de forma estándar. BCU está desarrollando el marco regulatorio. |
| Formatos de exportación manual | BROU, Itaú, Santander, Scotiabank exportan CSV/OFX desde home banking |
| Agregadores de cuentas | Ningún agregador certificado en Uruguay. Fiskil y Token.io observan el mercado. |
| Open banking BCU | Fase de consulta pública. Estimado de inicio: 2026–2027 |
| Scraping autorizado | Sin marco legal específico. UAFIU puede considerarlo acceso no autorizado. |

**Estrategia:** construir la abstracción correcta hoy (modelo de "cuenta bancaria") para que cuando lleguen las APIs sea solo agregar un conector, sin rediseñar el core.

---

## Etapa 4A — Cuentas bancarias y extractos manuales (disponible hoy)

Esta etapa extiende lo especificado en `features/bank-reconciliation.md` con énfasis en el modelo de datos y la arquitectura fintech.

### Paso 4A.1 — Modelo de cuentas bancarias multi-moneda

```sql
-- migrations/0013_bank.sql (ya especificado en features/bank-reconciliation.tech.md)
-- Extensión para preparación fintech:

CREATE TABLE bank_accounts (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  company_id      TEXT NOT NULL,
  banco           TEXT NOT NULL,     -- brou | itau | santander | scotiabank | hsbc | otro
  numero_cuenta   TEXT,              -- cifrado — datos sensibles financieros
  iban            TEXT,              -- si aplica (futuro open banking)
  moneda          TEXT DEFAULT 'UYU', -- UYU | USD | EUR
  alias           TEXT NOT NULL,
  tipo            TEXT DEFAULT 'corriente', -- corriente | caja_ahorro | deposito | credito
  saldo_conocido  REAL,              -- último saldo conocido
  saldo_fecha     INTEGER,           -- timestamp del último saldo conocido
  source          TEXT DEFAULT 'manual', -- manual | openbanking_api | scraping (futuro)
  connection_id   TEXT,              -- FK a openbanking_connections (Etapa 4C)
  activa          INTEGER DEFAULT 1,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_bank_accounts_tenant ON bank_accounts(tenant_id, company_id);
```

**Cifrado del número de cuenta:** igual que los tokens OAuth (AES-256-GCM). El número de cuenta es un dato financiero sensible bajo Ley 18.331 y potencialmente regulado por BCU.

### Paso 4A.2 — Importadores de extractos

La tabla `bank_statements` y `bank_transactions` ya están especificadas en `features/bank-reconciliation.tech.md`. Agregar:

```typescript
// src/services/bank-parser.ts — detectores automáticos de formato

type ParsedStatement = {
  banco: string
  cuenta: string | null
  periodo: { mes: number; anio: number }
  saldo_apertura: number
  saldo_cierre: number
  transacciones: ParsedTransaction[]
}

// Detectores de banco por estructura del CSV
const BANK_DETECTORS = [
  { banco: 'brou',       detect: (headers: string[]) => headers.includes('Suc.Orig.') },
  { banco: 'itau',       detect: (headers: string[]) => headers.includes('Numero Cuenta') && headers.includes('Saldo') },
  { banco: 'santander',  detect: (headers: string[]) => headers.includes('Movimiento') && headers.includes('Referencia') },
  { banco: 'scotiabank', detect: (headers: string[]) => headers.includes('Transaction Date') },
]
```

### Paso 4A.3 — Matching automático con CFEs

Una vez importado el extracto, el sistema cruza automáticamente contra los CFEs del mes:

```typescript
// Algoritmo de matching
// Para cada transacción bancaria:
//   1. Buscar CFEs del mismo mes donde total ≈ monto (±1% por redondeo)
//   2. Verificar que la fecha del CFE esté dentro de ±5 días de la fecha del movimiento
//   3. Si el RUT del receptor del CFE aparece en la descripción → match de alta confianza
//   4. Si solo coinciden monto+fecha → match de baja confianza (requiere confirmación)
```

---

## Etapa 4B — Dashboard de Tesorería (disponible hoy con datos manuales)

### Objetivo

Agregar una vista de tesorería que consolide múltiples cuentas bancarias y proyecte flujo de caja.

### Páginas

- `/app/tesoreria` — Vista consolidada de saldos por empresa (todas las cuentas bancarias)
- `/app/tesoreria/flujo` — Flujo de caja: ingresos vs. egresos por mes (desde extractos importados)
- `/app/tesoreria/proyeccion` — Proyección a 3 meses basada en histórico + vencimientos conocidos

### Lógica de proyección (sin IA, determinista)

```typescript
// Proyección simple basada en promedios históricos + vencimientos conocidos
function projectCashFlow(
  historicalStatements: BankStatement[],
  upcomingObligations: FiscalEvent[]  // del Calendario Fiscal
): MonthlyProjection[] {
  const avgMonthlyIncome  = average(historicalStatements.map(s => s.total_credits))
  const avgMonthlyExpense = average(historicalStatements.map(s => s.total_debits))
  // Suma las obligaciones DGI/BPS conocidas del próximo mes
  const knownObligations  = upcomingObligations.filter(e => e.monto_estimado)
    .reduce((sum, e) => sum + e.monto_estimado, 0)
  // ...
}
```

---

## Etapa 4C — Open Banking vía API (cuando BCU lo habilite)

### Diseño abstracto del conector

La arquitectura está diseñada para que agregar un conector de open banking sea mínimamente invasivo:

```typescript
// src/services/banking/OpenBankingConnector.ts
interface OpenBankingConnector {
  provider: string
  authorize(tenantId: string, companyId: string): Promise<string>  // returns auth URL
  exchangeCode(code: string): Promise<OBTokens>
  getAccounts(tokens: OBTokens): Promise<OBAccount[]>
  getTransactions(tokens: OBTokens, accountId: string, from: Date, to: Date): Promise<OBTransaction[]>
  getBalance(tokens: OBTokens, accountId: string): Promise<OBBalance>
  refreshToken(tokens: OBTokens): Promise<OBTokens>
}

// Implementaciones futuras:
class BROUConnector implements OpenBankingConnector { /* ... */ }
class ItauConnector   implements OpenBankingConnector { /* ... */ }
// Cuando exista un agregador certificado en Uruguay:
class BankAggregatorConnector implements OpenBankingConnector { /* ... */ }
```

### Tabla de conexiones open banking

```sql
CREATE TABLE openbanking_connections (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  company_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,        -- brou | itau | santander | aggregator
  external_user_id TEXT,               -- ID del usuario en el banco
  access_token    TEXT NOT NULL,        -- cifrado AES-256-GCM
  refresh_token   TEXT,                 -- cifrado AES-256-GCM
  token_expiry    INTEGER,
  consent_id      TEXT,                 -- ID del consentimiento en el banco (si aplica)
  consent_expiry  INTEGER,              -- Los consentimientos open banking expiran (90 días típico)
  scopes          TEXT,                 -- JSON array de scopes concedidos
  connected_at    INTEGER NOT NULL,
  last_synced_at  INTEGER
);
```

### Requisitos BCU para operar como TPP (Third Party Provider)

Cuando el marco BCU esté vigente, para actuar como TPP (acceder a datos bancarios de terceros vía API) se requerirá:

1. **Registro ante BCU** como proveedor de servicios de información de cuentas (AISP — Account Information Service Provider)
2. **Certificado eIDAS** o equivalente BCU para autenticar las peticiones a los bancos
3. **Auditoría de seguridad** ISO 27001 o equivalente
4. **Cumplimiento PCI DSS** si se manejan datos de tarjetas (no aplica en el caso básico de solo lectura de cuentas)
5. **Política de privacidad** específica para datos financieros, más estricta que la actual
6. **Contrato con cada banco** durante el período de transición antes de que el framework sea totalmente obligatorio

**Recomendación:** iniciar el proceso de registro BCU cuando el framework regulatorio esté publicado. Mientras tanto, documentar toda la arquitectura de seguridad como preparación para la auditoría.

---

## Paso 4D — Compliance Anti-Lavado (UAFIU)

### ¿Por qué es relevante para Adviser?

Si Adviser maneja transacciones bancarias y pagos, puede quedar sujeto a la Ley 19.574 (Lavado de activos) como Sujeto Obligado No Financiero dependiendo de los servicios que ofrezca. Los estudios contables ya son sujetos obligados — si Adviser actúa como plataforma de su actividad, hereda responsabilidades.

### Medidas preventivas a diseñar desde ya

| Medida | Implementación en Adviser |
|--------|--------------------------|
| Identificación del cliente (KYC básico) | En `companies` guardar RUT, razón social verificada contra DGI |
| Registro de operaciones | `audit_log` ya cubre esto; extenderlo con categoría `financial_operation` |
| Alertas de operaciones inusuales | Workers AI puede detectar transacciones con patrones de riesgo (monto en redondo, muchas transferencias sucesivas, pagos a entidades de riesgo) |
| Límite de umbral para reporte | Las transacciones > USD 10.000 requieren reporte UAFIU; el sistema puede marcarlas |
| No operar con cuentas sospechosas | Feature flag `aml_screening_enabled` para activar checks contra listas OFAC/ONU/INTERPOL |

### Alertas AML con Workers AI

```typescript
const AML_SCREENING_PROMPT = `
Analizá esta transacción bancaria y determiná si presenta señales de alerta AML (lavado de activos):
- Monto: {monto} {moneda}
- Descripción: {descripcion}
- Tipo: {tipo}
- Frecuencia de transacciones similares este mes: {frecuencia}

Señales a buscar: operaciones en números redondos, fraccionamiento de pagos,
transacciones con jurisdicciones de alto riesgo, patrones inusuales vs. histórico.

Respondé en JSON: { "alerta": true|false, "nivel": "bajo|medio|alto", "motivo": "..." }
Si no hay señal, respondé: { "alerta": false }
`
```

---

## Etapa 4E — Pagos y cobros (Fase futura)

Una vez que Adviser maneja cuentas bancarias y tiene relación con BCU, el siguiente paso natural es facilitar pagos:

### Opciones con el stack actual

| Funcionalidad | Mecanismo | Estado |
|---------------|-----------|--------|
| Link de pago para facturas CFE | Integración MercadoPago / Paganza UY | Factible hoy |
| Débito automático de clientes | BROU Débitos / Redpagos | Requiere acuerdo comercial con BROU |
| Cobros ACH/SIPAP | BCU SIPAP (sistema de pagos interbancarios) | Requiere habilitación BCU |
| Tarjetas de crédito | MercadoPago / Kushki | Factible hoy (no requiere PCI si se usa hosted fields) |

**Nota PCI DSS:** si se procesan datos de tarjetas directamente (números de tarjeta), se requiere certificación PCI DSS. Si se usa un proveedor como MercadoPago con "hosted fields" (el campo de tarjeta lo maneja el proveedor), no se requiere certificación PCI DSS para Adviser.

---

## Entregables de la Fase 4

| Entregable | Etapa | Descripción |
|------------|-------|-------------|
| `migrations/0013_bank.sql` | 4A | Tablas banco (ya en features/) + columnas fintech |
| `src/services/bank-crypto.ts` | 4A | Cifrado de números de cuenta |
| `src/services/bank-parser.ts` | 4A | Parseadores CSV/OFX multi-banco |
| `src/services/bank-categorizer.ts` | 4A | Categorización con Workers AI |
| `src/services/bank-reconciler.ts` | 4A | Matching con CFEs |
| `src/routes/bank.ts` | 4A | Endpoints /api/bank/* |
| `web/pages/app/tesoreria.astro` | 4B | Dashboard de tesorería |
| `src/services/banking/connector.ts` | 4C | Interfaz abstracta OpenBankingConnector |
| `migrations/0019_openbanking.sql` | 4C | Tabla `openbanking_connections` |
| `src/services/aml-screening.ts` | 4D | Alertas AML con Workers AI |

---

## Roadmap de open banking según regulación BCU

```
2025 Q3-Q4 → BCU publica framework open banking (consulta pública activa)
2026 Q1    → Marco regulatorio BCU aprobado (estimado)
2026 Q2    → Bancos grandes (BROU, Itaú) habilitan sandbox
2026 Q3    → Adviser solicita registro como AISP ante BCU
2026 Q4    → Primera integración con BROU en ambiente de prueba
2027 Q1    → Producción con bancos habilitados
```

Mientras tanto: **importación manual CSV/OFX + conciliación IA** resuelve el 80% del problema hoy.
