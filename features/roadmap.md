# Roadmap de Features — Adviser

Resumen consolidado de todas las funcionalidades de la plataforma, organizadas por estado de desarrollo y prioridad estratégica.

## Estado actual (implementado)

| Feature | Descripción | Archivo |
|---------|-------------|---------|
| ✅ OTP Auth + Multi-tenant | Login sin contraseña; primer login crea tenant | `auth-otp.md` |
| ✅ Contextual RAG | Retrieval semántico + léxico sobre corpus legislativo UY | `contextual-rag.md` |
| ✅ Hybrid Search | Vectorize (semántico) + D1 FTS5 (léxico) | `hybrid-search.md` |
| ✅ AI Grounded Answers | Respuestas fundamentadas con cita normativa obligatoria | `ai-grounded-answers.md` |
| ✅ PII Sanitization | Redacción de CI, RUT y montos antes de enviar a IA | `pii-sanitization.md` |
| ✅ Document Ingestion | Pipeline de ingestión de normativa DGI/BPS | `document-ingestion.md` |
| ✅ Document Storage (R2) | Almacenamiento en R2, importación Google Docs/Sheets | `document-storage.md` |
| ✅ Tax Analysis | Análisis fiscal mensual con IA; períodos y consolidación | `tax-analysis.md` |
| ✅ Company Profiles | Fichas de empresas con RUT, régimen, actividad | `company-profiles.md` |
| ✅ Fiscal Calendar | Calendario visual de vencimientos DGI/BPS | `fiscal-calendar.md` |
| ✅ Feature Flags | Flags por tenant con fallback global en D1 | `feature-flags.md` |
| ✅ Rate Limiting | 20 req/IP/60s vía Workers Rate Limiting | `rate-limiting.md` |
| ✅ Public/Private Web | Landing pública + producto privado con auth guard | `public-private-web.md` |

---

## Próximas features — alta prioridad

Seleccionadas en base al análisis de casuísticas del mercado contable uruguayo: puntos de dolor más frecuentes de estudios contables, PyMEs y personas físicas.

### 🔶 v2 — Corto plazo (3–6 meses)

| Feature | Segmento | Impacto | Archivo |
|---------|----------|---------|---------|
| **Simulador IRPF + Calculadoras Fiscales** | Personas / PyMEs | Alto — funnel de adquisición público, alta demanda estacional (junio) | `irpf-simulator.md` |
| **Notificaciones Inteligentes** | Todos | Alto — reduce multas por vencimiento; diferenciador vs competencia | `smart-notifications.md` |
| **Equipos y Roles Multi-usuario** | Estudios contables | Alto — bloquea crecimiento sin esto; requisito para estudios con staff | `multi-user-teams.md` |
| **Portal del Cliente** | Estudios contables | Alto — resuelve el cuello de botella de recolección de documentos | `client-portal.md` |

### 🔷 v3 — Mediano plazo (6–12 meses)

| Feature | Segmento | Impacto | Archivo |
|---------|----------|---------|---------|
| **Integración e-Factura / CFE** | PyMEs / Estudios | Muy alto — obligatorio para empresas; mercado con alto willingness to pay | `e-factura-integration.md` |
| **Liquidación de Sueldos** | PyMEs / Estudios | Alto — proceso mensual crítico; elimina planillas Excel manuales | `payroll-processing.md` |
| **Conciliación Bancaria** | Todos | Alto — proceso tedioso de alto valor; diferenciador claro vs soluciones actuales | `bank-reconciliation.md` |

---

## Features identificadas a futuro (v4+)

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
- **SIGA DGI**: prefill de formularios DGI desde los datos calculados en Adviser.
- **SUNA BPS**: envío directo de la declaración mensual al portal BPS.
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
