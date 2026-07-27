# Feature: Liquidación de Sueldos (Payroll Processing)

## Descripción

Módulo de cálculo y gestión de liquidaciones de haberes para empresas uruguayas. Automatiza el cálculo de IRPF Categoría 1, aportes BPS (patronales y personales), FONASA, FRL y retenciones sindicales según la escala oficial vigente del BPS/DGI, generando el recibo de sueldo en PDF y los archivos para la declaración SUNA.

## Casuística de mercado

Este es uno de los **mayores puntos de dolor** de PyMEs y estudios contables en Uruguay:

- Las escalas de IRPF Cat. 1 se actualizan periódicamente (ajuste por IPC, salario mínimo nacional).
- El cálculo de BPS varía por tipo de actividad, categoría del trabajador y si aplica bonificación por presentación.
- Errores en la liquidación implican multas DGI/BPS y conflictos laborales.
- Empresas con 2–20 empleados no justifican un sistema de RR.HH. completo, pero necesitan precisión.
- Los estudios contables liquidan sueldos para decenas de clientes cada mes — hoy lo hacen en planillas Excel manuales.

## Casos de uso

- **UC-070** Un estudio contable carga los empleados de su cliente "Empresa XYZ SRL" (nombre, salario nominal, categoría BPS, sindicato). Cada mes ejecuta la liquidación y descarga los recibos individuales en PDF.
- **UC-071** Un empleado con sueldo nominal de $70.000 y un complemento de $15.000 obtiene el detalle de deducciones: IRPF, FONASA tasa alta, BPS personal, con el líquido resultante.
- **UC-072** La IA asiste en la interpretación: "¿A qué escala IRPF corresponde este empleado?" — responde con la norma vigente y el cálculo paso a paso.
- **UC-073** Al cerrar el período mensual, se genera el archivo SUNA (formato BPS) listo para subir al portal de declaraciones.
- **UC-074** Un empleado que trabaja en dos empresas simultáneamente puede calcular el IRPF global para evitar saldo deudor al cierre del ejercicio.

## Modelo de datos

```sql
employees (
  id, user_id, tenant_id, company_id,
  nombre           TEXT,
  cedula           TEXT,
  fecha_ingreso    DATE,
  cargo            TEXT,
  salario_nominal  REAL,
  categoria_bps    TEXT,   -- dependiente | no_dependiente | servicio_domestico | etc.
  sindicato        TEXT,
  activo           INTEGER DEFAULT 1,
  created_at, updated_at
)

payroll_periods (
  id, user_id, tenant_id, company_id,
  month INTEGER, year INTEGER,
  status TEXT,   -- draft | calculated | closed
  created_at
)

payroll_items (
  id, period_id, employee_id,
  salario_nominal  REAL,
  horas_extra      REAL,
  complementos     REAL,
  total_bruto      REAL,
  -- Deducciones
  irpf             REAL,
  bps_personal     REAL,
  fonasa           REAL,
  frl              REAL,
  sindicato        REAL,
  otras_deducciones REAL,
  -- Liquidado
  liquido          REAL,
  -- Costos patronales
  bps_patronal     REAL,
  -- Metadata
  detalle_json     TEXT,   -- cálculo detallado para auditoría
  generated_at     TIMESTAMP
)
```

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`    | `/api/payroll/employees` | Lista empleados por empresa |
| `POST`   | `/api/payroll/employees` | Crea empleado |
| `PUT`    | `/api/payroll/employees/:id` | Actualiza datos del empleado |
| `DELETE` | `/api/payroll/employees/:id` | Da de baja lógica (activo=0) |
| `POST`   | `/api/payroll/periods` | Crea período de liquidación |
| `POST`   | `/api/payroll/periods/:id/calculate` | Ejecuta cálculo para todos los empleados |
| `GET`    | `/api/payroll/periods/:id/items` | Lista items liquidados |
| `GET`    | `/api/payroll/periods/:id/items/:empId/pdf` | Genera recibo en PDF |
| `GET`    | `/api/payroll/periods/:id/suna` | Genera archivo SUNA para BPS |

## Cálculo — reglas de negocio Uruguay

### Escalas IRPF Categoría 1 (ajustadas por decreto)

```
Tramo 1: hasta 7 BPC → 0%
Tramo 2: 7–10 BPC    → 10%
Tramo 3: 10–15 BPC   → 15%
Tramo 4: 15–50 BPC   → 20%
Tramo 5: 50–75 BPC   → 22%
Tramo 6: > 75 BPC    → 25%
(BPC 2025: $6.188)
```

### Aportes BPS

| Concepto | Tasa personal | Tasa patronal |
|----------|--------------|---------------|
| Jubilación | 15% | 7.5% |
| Enfermedad (FONASA) | 3–4.5% según salario | 5% |
| FRL | 0.1% | — |
| Seguro desempleo | — | 0.15% |

## Integración con IA

La IA (contextual RAG) puede responder preguntas como:
- "¿Cuándo corresponde aplicar la tasa alta de FONASA?"
- "¿Qué tipo de complementos son gravados por IRPF?"
- "¿Cómo se calcula el aguinaldo?"

usando el corpus normativo BPS/DGI ya ingresado.

## Páginas

- `/app/empleados` — ABM de empleados por empresa
- `/app/sueldos` — Períodos de liquidación con estado
- `/app/sueldos/periodo?id=` — Detalle de liquidación con tabla de items y acciones de descarga

## Mejoras futuras (v2)

- Liquidación de aguinaldo y licencia anual reglamentaria
- Exportación a formato BROU/ABITAB para pago de haberes
- Integración directa con portal SUNA de BPS vía API
- Histórico de escalas para re-liquidar períodos pasados
- Notificación automática al empleado con su recibo vía email

## Checklist de implementación

### Prerequisito
- [ ] Repositorio `MathiasGonzalez/FluentReport` desplegado como Cloudflare Container
- [ ] Binding `REPORT_CONTAINER` configurado en `wrangler.jsonc`

### Base de datos
- [ ] Tabla `employees` creada con índices `(tenant_id, company_id)`
- [ ] Tabla `payroll_periods` creada con estado `draft | calculated | closed`
- [ ] Tabla `payroll_items` creada con todos los campos de cálculo y `detalle_json` para auditoría

### Backend
- [ ] `GET /api/payroll/employees` — lista empleados por empresa
- [ ] `POST /api/payroll/employees` — crea empleado con validación de CI y categoría BPS
- [ ] `PUT /api/payroll/employees/:id` — actualiza datos del empleado
- [ ] `DELETE /api/payroll/employees/:id` — baja lógica (`activo = 0`)
- [ ] `POST /api/payroll/periods` — crea período de liquidación
- [ ] `POST /api/payroll/periods/:id/calculate` — ejecuta cálculo para todos los empleados activos
- [ ] `GET /api/payroll/periods/:id/items` — lista items liquidados
- [ ] `GET /api/payroll/periods/:id/items/:empId/pdf` — genera recibo PDF via FluentReport
- [ ] `GET /api/payroll/periods/:id/suna` — genera archivo SUNA para BPS
- [ ] Cálculo de IRPF Cat.1 por tramos BPC implementado con escala vigente
- [ ] Cálculo de aportes BPS (jubilación, FONASA, FRL, seguro desempleo) implementado
- [ ] `src/config/tax-tables.ts` con BPC vigente y escalas IRPF Cat.1 actualizadas

### Frontend
- [ ] `/app/empleados` — ABM de empleados por empresa
- [ ] `/app/sueldos` — lista de períodos de liquidación con estado y acciones
- [ ] `/app/sueldos/:id` — detalle de período con tabla de items y botón de descarga de recibos

### Validación
- [ ] UC-070: liquidación de empleados de empresa con descarga de recibos PDF
- [ ] UC-071: desglose correcto para empleado con sueldo $70.000 + complemento $15.000
- [ ] UC-072: IA asiste con consultas sobre escalas IRPF y BPS usando corpus RAG
- [ ] UC-073: archivo SUNA generado correctamente para el período
- [ ] UC-074: cálculo IRPF para empleado con doble empleo funciona correctamente

### Pendiente (v2)
- [ ] Liquidación de aguinaldo y licencia
- [ ] Gestión de ausencias vinculada a liquidación
- [ ] Alta/baja en BPS: asistencia para formularios SUNA
