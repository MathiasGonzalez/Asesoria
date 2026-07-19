# Feature: Simulador IRPF y Calculadoras Fiscales

## Descripción

Herramientas de cálculo fiscal interactivas para personas físicas y empresas uruguayas: simulador de IRPF Categoría 2 (rentas del trabajo), calculadora de monotributo, estimador de IRAE y comparador de regímenes tributarios. Permite planificar la carga tributaria antes del cierre del ejercicio y tomar decisiones informadas sobre el régimen más conveniente.

## Casuística de mercado

Este es uno de los **casos de uso más demandados por personas individuales** en Uruguay:

- Cada año en junio (cierre de IRPF Cat. 2), miles de trabajadores no saben si tienen saldo a pagar o a cobrar.
- Los empleados con pluriempleo (dos empleadores) frecuentemente acumulan retenciones insuficientes.
- Los freelancers y trabajadores independientes no saben si conviene tributar como IRAE real, IRAE pequeña empresa o monotributo.
- Las personas que alquilan inmuebles no calculan correctamente la deducción del 12% de BPS y terminan pagando de más.
- Emprendedores que están por constituir una empresa no saben qué forma societaria y régimen les conviene fiscalmente.

## Casos de uso

- **UC-110** Un empleado con sueldo de $80.000 en empresa A y $40.000 en empresa B usa el simulador para calcular cuánto IRPF global pagará en el ejercicio y si deberá solicitar un certificado a una de las empresas para ajustar retenciones.
- **UC-111** Un freelancer que factura $500.000 mensuales consulta si le conviene monotributo, IRAE pequeña empresa o régimen real. El simulador compara las tres opciones con carga tributaria total y límites de facturación.
- **UC-112** Una persona con ingresos de alquiler de $25.000 mensuales calcula el IRNR (persona física no residente) o el IRPF Cat. 2 (residente), según su situación.
- **UC-113** Una empresa en crecimiento proyecta que superará el tope de IRAE pequeña empresa. El simulador estima el impacto en la carga tributaria al migrar al régimen real.
- **UC-114** Un trabajador independiente calcula su Monotributo según la categoría A o B, comparándolo con el costo de ser dependiente (BPS + IRPF).

## Calculadoras incluidas

### 1. Simulador IRPF Categoría 2 (Rentas del trabajo)

**Inputs:**
- Ingresos de cada empleador (puede ser múltiple)
- Deducciones: BPS personal, FONASA, FRL, cuotas mutuales, gastos médicos
- Préstamos hipotecarios (deducción IRPF)
- Hijos a cargo (deducción por hijo)
- Alquileres pagados (deducción 6% de arrendamiento)

**Outputs:**
- IRPF global del ejercicio
- Retenciones acumuladas en el año
- Saldo a pagar o crédito a recuperar
- Recomendación: solicitar certificado de retención adicional

### 2. Simulador Monotributo

**Inputs:**
- Ingresos mensuales
- Actividad (comercio / servicio)
- Si tiene local o trabaja desde casa

**Outputs:**
- Categoría (A o B) y cuota mensual vigente
- Tope de facturación anual y qué pasa al superarlo
- Comparativa vs IRAE pequeña empresa

### 3. Calculadora IRAE Pequeña Empresa vs Real

**Inputs:**
- Ingresos proyectados anuales
- Costos principales
- Nómina de personal

**Outputs:**
- Carga tributaria estimada en cada régimen
- Punto de equilibrio (cuándo conviene cambiar de régimen)
- Tope legal vigente para pequeña empresa

### 4. Calculadora IRNR (no residentes)

**Inputs:**
- Tipo de renta (arrendamiento, dividendos, intereses)
- Monto

**Outputs:**
- Tasa aplicable y retención estimada

## Modelo de datos

Las calculadoras son **stateless** (no persisten en D1): operan en el worker con lógica pura y parámetros de tablas fiscales vigentes mantenidos como constantes actualizables.

```typescript
// src/services/tax-calculators.ts
interface IRPFSimulationInput { incomes: IncomeSource[]; deductions: Deduction[] }
interface IRPFSimulationResult { totalTax: number; totalWithheld: number; balance: number; breakdown: TaxBracket[] }

function calculateIRPFCat2(input: IRPFSimulationInput): IRPFSimulationResult
function calculateMonotributo(monthlyIncome: number, activityType: 'comercio' | 'servicio'): MonotributoResult
function compareRegimes(params: RegimeComparisonInput): RegimeComparisonResult
```

Los parámetros fiscales (BPC, escalas, cuotas) se mantienen en un archivo de configuración versionado (`src/config/tax-tables.ts`) que se actualiza con cada ajuste DGI/BPS.

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST`   | `/api/calculators/irpf` | Simula IRPF Cat. 2 anual |
| `POST`   | `/api/calculators/monotributo` | Calcula cuota monotributo |
| `POST`   | `/api/calculators/irae-comparison` | Compara regímenes IRAE |
| `POST`   | `/api/calculators/irnr` | Calcula IRNR |
| `GET`    | `/api/calculators/tax-tables` | Devuelve tablas fiscales vigentes con fecha de actualización |

Los endpoints **no requieren autenticación** — son herramientas públicas para captar usuarios.

## Integración con IA

El simulador puede invocar al asistente RAG para preguntas como:
- "¿Qué gastos son deducibles para IRPF Cat. 2 en Uruguay?"
- "¿Cuál es la tasa de BPS para trabajadores independientes en 2025?"
- "¿Cómo funciona la deducción por hijos a cargo?"

## Páginas

- `/calculadoras` (**pública**, sin login) — Hub de calculadoras con SEO optimizado
- `/calculadoras/irpf` — Simulador IRPF interactivo paso a paso
- `/calculadoras/monotributo` — Calculadora monotributo con comparativa
- `/calculadoras/regimenes` — Comparador de regímenes tributarios

> Las calculadoras públicas sirven como **funnel de adquisición**: el usuario las usa sin login y, al querer guardar la simulación o aplicarla a un período real, se le invita a registrarse.

## Mejoras futuras (v2)

- Historial de simulaciones guardadas por usuario autenticado
- Alertas automáticas cuando cambian las tablas fiscales que afectan una simulación guardada
- Simulador de sueldo neto para ofertas laborales (cuánto paga el empleado y la empresa por un sueldo de $X)
- Calculadora de precio de venta con IVA incluido/excluido
- Exportación de simulaciones en PDF para presentar a clientes
