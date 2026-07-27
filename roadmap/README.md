# Adviser — Roadmap Estratégico de Producto

## Resumen ejecutivo

Adviser. ya tiene construidas las fundaciones sólidas de un asistente regulatorio tributario. Este roadmap convierte ese núcleo en una **plataforma contable-fintech de extremo a extremo** para el mercado uruguayo, viable con el stack actual de Cloudflare y preparada para operar dentro del marco regulatorio del BCU cuando el open banking se formalice.

---

## Estado actual (implementado)

| Módulo | Estado | Descripción |
|--------|--------|-------------|
| OTP Auth + Multi-tenant | ✅ Producción | Login sin contraseña, primer login crea tenant |
| Contextual RAG | ✅ Producción | Retrieval semántico + léxico sobre corpus normativo DGI/BPS |
| AI Grounded Answers | ✅ Producción | Respuestas con cita normativa obligatoria |
| PII Sanitization | ✅ Producción | Redacción de CI, RUT, montos antes de enviar a IA |
| Document Storage (R2) | ✅ Producción | Subida de archivos + importación Google Docs públicos |
| Tax Analysis | ✅ Producción | Análisis fiscal mensual con IA por empresa y período |
| Company Profiles | ✅ Producción | Fichas con RUT, régimen, actividad |
| Fiscal Calendar | ✅ Producción | Vencimientos DGI/BPS visuales |
| Feature Flags | ✅ Producción | Flags por tenant con fallback global |
| Rate Limiting | ✅ Producción | 20 req/IP/60s |

---

## Fases del Roadmap

### [Fase 1 — Hardening de Tenant y Fundaciones](./fase-1-hardening.md)
**Prerequisito obligatorio** para todo lo que sigue. Consolida el aislamiento de datos por tenant, auditoría, cuotas y gestión de documentos robusta.

### [Fase 2 — Document Hub con OAuth Externo](./fase-2-document-hub.md)
**Integración con donde las empresas ya guardan sus documentos**: Google Drive, Microsoft OneDrive/SharePoint, Dropbox. OAuth 2.0 con tokens cifrados, sincronización diferencial y OCR automático.

### [Fase 3 — Agentes IA Especializados](./fase-3-agentes-especializados.md)
**Evolución del asistente genérico a agentes dominio-específicos**: agente tributario, agente payroll, agente de conciliación bancaria, agente de compliance. Diseño con orquestador y guardrails de revisión humana.

### [Fase 4 — Capa Bancaria y Preparación Fintech](./fase-4-openbanking.md)
**Manejo de cuentas bancarias, conciliación y open banking**: desde importación manual CSV/OFX hasta conectores API cuando la regulación BCU lo permita. Incluye arquitectura para cumplir requerimientos fintech (Ley 19.210, Ley 18.838, UAFIU).

### [Referencia: Cumplimiento Regulatorio Fintech Uruguay](./fintech-regulatorio-uy.md)
Marco regulatorio de referencia: BCU, UAFIU, URCDP, Código Tributario. Guía de diseño para que cada feature respete las restricciones legales vigentes.

---

## Dependencias entre fases

```
Fase 1 (Hardening)
    └── Fase 2 (Document Hub OAuth)
    └── Fase 3 (Agentes IA) — requiere Fase 1 completada
    └── Fase 4 (Capa Bancaria) — requiere Fase 1 + parcialmente Fase 2

Fase 4 (Open Banking) — requiere Fase 4 bancaria + Marco regulatorio BCU
```

---

## Criterios de priorización

1. **¿Resuelve un dolor hoy?** → Prioridad alta
2. **¿Genera retención / lock-in del cliente?** → Prioridad alta
3. **¿Está bloqueado por regulación pendiente?** → Diferir
4. **¿El stack Cloudflare lo soporta sin rediseño?** → Prioridad alta
5. **¿Introduce riesgo de compliance (Ley 18.331, secreto tributario)?** → Diseñar primero el marco legal

---

## Stack Cloudflare de referencia

| Servicio CF | Uso en Adviser |
|-------------|---------------|
| **Workers** (Hono) | API, auth, middleware, orquestación |
| **D1** (SQLite) | Base de datos relacional + FTS5 |
| **R2** | Almacenamiento de documentos, extractos bancarios, archivos sync |
| **Vectorize** | Búsqueda semántica (embeddings 768-dim) |
| **Workers AI** | LLM inference, embeddings, OCR (Fase 2) |
| **Durable Objects** | Agentes stateful de larga ejecución (Fase 3) |
| **Queues** | Procesamiento asíncrono (sync OAuth, categorización batch) |
| **Browser Rendering** | Automatización portales DGI/BPS |
| **Containers** (.NET 10) | UruFactura (e-Factura), FluentReport (PDF) |
| **KV** | Cache de tokens OAuth, rate limit state |
