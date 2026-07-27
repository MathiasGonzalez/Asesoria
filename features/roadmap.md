# Roadmap de Features — Adviser

Todas las features listadas en este documento son **obligatorias** para el producto. El orden refleja la secuencia de implementación, no la opcionalidad. Cada feature tiene su especificación funcional (`.md`) y su especificación técnica (`.tech.md`) en esta carpeta.

## Fase 1 — Fundaciones (implementado)

| Feature | Descripción | Spec | Tech |
|---------|-------------|------|------|
| OTP Auth + Multi-tenant | Login sin contraseña; primer login crea tenant | `auth-otp.md` | `auth-otp.tech.md` |
| Contextual RAG | Retrieval semántico + léxico sobre corpus legislativo UY | `contextual-rag.md` | `contextual-rag.tech.md` |
| Hybrid Search | Vectorize (semántico) + D1 FTS5 (léxico) | `hybrid-search.md` | `hybrid-search.tech.md` |
| AI Grounded Answers | Respuestas fundamentadas con cita normativa obligatoria | `ai-grounded-answers.md` | `ai-grounded-answers.tech.md` |
| PII Sanitization | Redacción de CI, RUT y montos antes de enviar a IA | `pii-sanitization.md` | `pii-sanitization.tech.md` |
| Document Ingestion | Pipeline de ingestión de normativa DGI/BPS | `document-ingestion.md` | `document-ingestion.tech.md` |
| Document Storage (R2) | Almacenamiento en R2, importación Google Docs/Sheets | `document-storage.md` | `document-storage.tech.md` |
| Tax Analysis | Análisis fiscal mensual con IA; períodos y consolidación | `tax-analysis.md` | `tax-analysis.tech.md` |
| Company Profiles | Fichas de empresas con RUT, régimen, actividad | `company-profiles.md` | `company-profiles.tech.md` |
| Fiscal Calendar | Calendario visual de vencimientos DGI/BPS | `fiscal-calendar.md` | `fiscal-calendar.tech.md` |
| Feature Flags | Flags por tenant con fallback global en D1 | `feature-flags.md` | `feature-flags.tech.md` |
| Rate Limiting | 20 req/IP/60s vía Workers Rate Limiting | `rate-limiting.md` | `rate-limiting.tech.md` |
| Public/Private Web | Landing pública + producto privado con auth guard | `public-private-web.md` | `public-private-web.tech.md` |

---

## Fase 2 — Colaboración y personas (obligatorio)

| Feature | Segmento | Descripción | Spec | Tech |
|---------|----------|-------------|------|------|
| Equipos y Roles Multi-usuario | Estudios | Roles owner/admin/senior/accountant/client con permisos granulares | `multi-user-teams.md` | `multi-user-teams.tech.md` |
| Portal del Cliente | Estudios | Solicitudes de documentos, aprobaciones digitales, informes compartidos | `client-portal.md` | `client-portal.tech.md` |
| Simulador IRPF + Calculadoras | Personas / PyMEs | Calculadoras públicas sin login — funnel de adquisición | `irpf-simulator.md` | `irpf-simulator.tech.md` |
| Notificaciones Inteligentes | Todos | Email + WhatsApp + Push para vencimientos y actividad | `smart-notifications.md` | `smart-notifications.tech.md` |

---

## Fase 3 — Operaciones contables (obligatorio)

| Feature | Segmento | Descripción | Spec | Tech |
|---------|----------|-------------|------|------|
| Integración e-Factura / CFE | PyMEs / Estudios | Emisión y recepción CFE vía **UruFactura** (Cloudflare Container .NET) | `e-factura-integration.md` | `e-factura-integration.tech.md` |
| Liquidación de Sueldos | PyMEs / Estudios | Cálculo BPS/IRPF Cat.1, recibos PDF vía **FluentReport** Container | `payroll-processing.md` | `payroll-processing.tech.md` |
| Conciliación Bancaria | Todos | Importación CSV/OFX, categorización IA, reporte PDF vía **FluentReport** | `bank-reconciliation.md` | `bank-reconciliation.tech.md` |

---

## Servicios externos compartidos

Estas especificaciones técnicas son transversales y son referenciadas por múltiples features:

| Servicio | Spec | Usado por |
|----------|------|-----------|
| **FluentReport Container** | `fluentreport-container.tech.md` | tax-analysis, payroll-processing, client-portal, bank-reconciliation |
| **UruFactura Container** | `e-factura-integration.tech.md` | e-factura-integration (spec embebida) |

---

## Fase 4+ — Expansión (backlog obligatorio)

Funcionalidades derivadas del análisis de mercado que representan oportunidades de expansión. **Sin especificación técnica detallada aún.**

### Contabilidad y reportes

- **Balance y Estado de Resultados automático**: generar balance general y estado de resultados desde los documentos del período, con asistencia IA para identificar inconsistencias.
- **Libro Diario asistido**: registro de asientos contables con sugerencias de IA basadas en los documentos adjuntos.
- **Exportación a software contable**: integración con Defontana, Alegra, Conta1, Xero — generar archivos de importación desde los datos de Adviser.
- **Comparativa entre períodos**: gráficos de evolución de IVA, IRAE, BPS entre meses y años.

### Facturación y cobranza

- **Facturación recurrente**: CFEs automáticos para servicios mensuales con cargo automático.
- **Portal de cobros**: enviar link de pago a clientes (integración MercadoPago / BROU Pagos).
- **Seguimiento de cuentas a cobrar**: aging de facturas pendientes con recordatorios automáticos al deudor.
- **Cotizaciones y presupuestos**: generar presupuestos que se convierten en CFE con un click.

### Recursos Humanos extendido

- **Liquidación de aguinaldo y licencia**: cálculo automático de beneficios anuales obligatorios.
- **Gestión de ausencias**: registro de licencias, enfermedad e inasistencias vinculado a la liquidación.
- **Contratos de trabajo**: generación de contratos laborales desde plantillas con datos del empleado.
- **Alta/baja en BPS**: asistencia para completar los formularios de alta y baja de trabajadores ante BPS.

### Inteligencia y analítica

- **Dashboard ejecutivo**: KPIs de la empresa: carga tributaria mensual, margen operativo, comparativa sectorial.
- **Proyección de caja**: forecasting de 3 meses basado en histórico de ingresos y egresos + vencimientos conocidos.
- **Alerta de anomalías**: la IA detecta movimientos inusuales (pico de facturación, gasto inesperado) y notifica.
- **Benchmark sectorial**: comparar carga tributaria y estructura de costos contra el promedio de empresas del mismo sector (datos anonimizados).

### Compliance y legal

- **Registro de poderes y mandatos**: gestión de poderes notariales y representaciones legales que el estudio ejerce para sus clientes.
- **Vencimientos de certificados**: alertas para certificados DGI (good standing), certificados BPS, poderes notariales, registros de comercio.
- **Due diligence de proveedores**: verificar situación fiscal de un proveedor ante DGI/BPS desde la plataforma.
- **Gestión de impugnaciones**: seguimiento de recursos y trámites abiertos ante DGI, BPS, aduanas.

### Expansión regional

- **Soporte Argentina (AFIP)**: adaptar el motor de análisis para normativa AFIP — IVA, Ganancias, Monotributo argentino.
- **Soporte Paraguay (SET)**: integración con la SET paraguaya para IVA, IRE, IRP.
- **Multi-moneda**: soporte nativo para operaciones en USD, EUR con tipos de cambio BCU/Banxico en tiempo real.
- **Jurisdicciones subnacionales**: municipios y departamentos uruguayos (contribuciones inmobiliarias, patentes).

### Integraciones externas

- **Open Banking (cuando disponible en UY)**: importación automática de extractos via API bancaria.
- **SIGA DGI / SUNA BPS**: automatización de portales gubernamentales vía browser headless para consultar deuda, estado de cuenta y descargar constancias. `dgi-bps-portal.md` | `dgi-bps-portal.tech.md`
- **Google Drive / Dropbox**: sincronización automática de documentos desde carpetas del cliente.
- **Zapier / Make**: webhooks para integrar con otras herramientas del negocio.

### Modelo de negocio y escala

- **Planes y suscripciones**: tiers Free / Pro / Estudio con feature gates por plan.
- **White-label**: estudios contables que quieren presentar Adviser con su propia marca a sus clientes.
- **Marketplace de plantillas**: biblioteca de prompts de análisis, plantillas de informes y flujos de trabajo reutilizables.
- **API pública**: permitir que desarrolladores construyan integraciones sobre la plataforma.

---

## Criterios de priorización

Al evaluar qué feature desarrollar a continuación, se consideran:

1. **Frecuencia de uso**: ¿cuántos usuarios lo necesitarían cada mes?
2. **Willingness to pay**: ¿los usuarios pagarían más por tener esta feature?
3. **Diferenciación**: ¿está disponible en competidores directos (Conta1, Defontana, Alegra)?
4. **Viabilidad técnica**: ¿el stack actual (Cloudflare Workers, D1, R2, Workers AI) lo soporta sin rediseño?
5. **Compliance**: ¿introduce riesgos legales (ley 18.331, secreto tributario)?

---

## Checklist de progreso por fase

### Fase 1 — Fundaciones (implementado)
- [x] OTP Auth + Multi-tenant
- [x] Contextual RAG
- [x] Hybrid Search
- [x] AI Grounded Answers
- [x] PII Sanitization
- [x] Document Ingestion
- [x] Document Storage (R2)
- [x] Tax Analysis
- [x] Company Profiles
- [x] Fiscal Calendar
- [x] Feature Flags
- [x] Rate Limiting
- [x] Public/Private Web

### Fase 2 — Colaboración y personas (obligatorio)
- [ ] Equipos y Roles Multi-usuario
- [ ] Portal del Cliente
- [ ] Simulador IRPF + Calculadoras
- [ ] Notificaciones Inteligentes

### Fase 3 — Operaciones contables (obligatorio)
- [ ] Integración e-Factura / CFE
- [ ] Liquidación de Sueldos (Payroll)
- [ ] Conciliación Bancaria
- [ ] Automatización Portales DGI/BPS

### Fase 4+ — Expansión (backlog obligatorio)
Ver `roadmap/README.md` para el detalle de las fases de expansión.
- [ ] Hardening de tenant y fundaciones (roadmap/fase-1-hardening.md)
- [ ] Document Hub con OAuth externo (roadmap/fase-2-document-hub.md)
- [ ] Agentes IA especializados (roadmap/fase-3-agentes-especializados.md)
- [ ] Capa bancaria y preparación fintech (roadmap/fase-4-openbanking.md)
