# Feature: Fiscal Calendar (Calendario de Vencimientos)

## Descripción

Calendario visual de obligaciones tributarias en Uruguay para el año fiscal. Muestra las fechas de vencimiento de los principales impuestos (IVA, IRAE, IRPF, BPS, Monotributo) con codificación de colores por urgencia, ayudando a contribuyentes y contadores a planificar sus pagos.

## Casos de uso

- **UC-060** Un contador visualiza en el calendario que el IVA del mes corriente vence en 5 días y que BPS venció hace 2 días. Las obligaciones urgentes aparecen en rojo, las próximas en naranja y las futuras en verde.
- **UC-061** Un usuario identifica el vencimiento del IRAE anual (Formulario 1101) en abril del año siguiente y lo planifica en su agenda.
- **UC-062** Las fechas se calculan dinámicamente en base al año seleccionado, respetando los calendarios oficiales de DGI/BPS.

## Obligaciones incluidas

### Obligaciones mensuales (DGI)

| Tributo | Vencimiento aproximado |
|---------|----------------------|
| IVA (Formulario FF) | Días 20-25 del mes siguiente (según último dígito RUT) |
| IRAE anticipo mensual | Días 20-25 del mes siguiente |
| IRPF Cat. 2 retenciones (Form. 2181) | Días 20-25 del mes siguiente |
| Monotributo | Día 10 del mes siguiente |

### Obligaciones mensuales (BPS)

| Obligación | Vencimiento |
|------------|-------------|
| Nómina BPS (SUNA) | Día 10 del mes siguiente al devengado |

### Obligaciones anuales

| Obligación | Vencimiento |
|------------|-------------|
| IRAE anual (Formulario 1101) | Abril-mayo del año siguiente |
| IRPF anual (Formulario 1102) | 30 de junio del año siguiente |
| IP (Impuesto al Patrimonio) | Con el cierre del ejercicio |

## Codificación de colores

| Color | Significado |
|-------|-------------|
| 🔴 Rojo | Vencido o vence hoy / mañana |
| 🟠 Naranja | Vence en los próximos 7 días |
| 🟢 Verde | Vence en más de 7 días |
| ⚪ Gris | Obligación anual (marco de tiempo extendido) |

## Página

- `/app/calendario` — vista de calendario con leyenda de colores y lista de vencimientos del mes actual

## Mejoras futuras

- Filtrado por empresa (ajustar vencimientos según dígito de RUT)
- Exportación al calendario de Google / iCal
- Notificaciones push / email (D-5 antes de cada vencimiento)
- Integración con los períodos de análisis para marcar obligaciones ya pagadas

## Checklist de implementación

### Backend
- [x] Lógica de cálculo de vencimientos mensuales DGI (IVA, IRAE anticipo, IRPF Cat.2, Monotributo) implementada
- [x] Lógica de cálculo de vencimientos BPS (SUNA, día 10 del mes siguiente) implementada
- [x] Vencimientos anuales (IRAE 1101, IRPF 1102, IP) incluidos
- [x] Codificación de colores por urgencia: rojo (≤1 día), naranja (≤7 días), verde (>7 días)
- [x] Cálculo dinámico por año seleccionado

### Frontend
- [x] `/app/calendario` — vista de calendario con lista de vencimientos del mes actual y leyenda de colores

### Validación
- [x] UC-060: IVA urgente en rojo, BPS vencido en rojo, obligaciones futuras en verde
- [x] UC-061: IRAE anual (Formulario 1101) aparece en abril del año siguiente
- [x] UC-062: fechas calculadas dinámicamente según año seleccionado

### Pendiente (v2)
- [ ] Filtrado por empresa y ajuste de vencimiento según dígito de RUT
- [ ] Exportación a Google Calendar / iCal
- [ ] Notificaciones push/email D-5 (ver `smart-notifications.md`)
- [ ] Integración con períodos de análisis para marcar obligaciones ya pagadas
