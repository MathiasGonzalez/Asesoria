# Cumplimiento Regulatorio Fintech — Uruguay

## Objetivo

Guía de referencia para el equipo de Adviser. Documenta el marco legal uruguayo relevante para cada feature de la plataforma, las obligaciones actuales y las que se activarán al agregar capacidades fintech (cuentas bancarias, pagos, open banking).

---

## Leyes y organismos clave

| Norma | Organismo | Relevancia para Adviser |
|-------|-----------|------------------------|
| **Código Tributario — Art. 47** | DGI | Secreto tributario. Los datos fiscales de los clientes no pueden compartirse sin autorización expresa. |
| **Ley 18.331 (URCDP)** | URCDP | Protección de datos personales. Aplica a toda información de personas físicas. |
| **Ley 18.838** | BCU | Sistema de Pagos del Uruguay. Regula entidades que procesen pagos. |
| **Ley 19.210** | BCU / BROU | Inclusión financiera. Define obligaciones de medios de pago electrónico. |
| **Ley 19.574 + Dec. 379/018** | UAFIU | Lavado de activos. Los estudios contables son sujetos obligados. |
| **Ley 19.484** | DGI / BCU | Transparencia fiscal, intercambio de información (CRS/FATCA). |
| **Ley 18.335** | MSP | Derechos de los pacientes (no aplica directamente, pero patrón similar para datos sensibles) |
| **BCU Circular 2395** | BCU | SIPAP — sistema interbancario de pagos |
| **Marco Open Banking BCU** | BCU | En desarrollo (2025). Regulará el acceso de TPPs a datos bancarios. |

---

## Obligaciones actuales por feature

### RAG / Consultas normativas

| Obligación | Implementación actual |
|------------|----------------------|
| Art. 47 — secreto tributario | PII Sanitization: redacción de RUT, CI, montos antes de enviar al modelo |
| Ley 18.331 — datos personales | Los documentos de los usuarios nunca salen del tenant; el corpus normativo es público |
| Grounding obligatorio | Respuestas solo desde corpus oficial; no se generan respuestas sin fuente |

**Estado:** ✅ Cumplimiento actual satisfactorio.

---

### Almacenamiento de documentos (R2 + D1)

| Obligación | Implementación requerida |
|------------|-------------------------|
| Ley 18.331 Art. 11 — seguridad | Cifrado en reposo en R2 (activar SSE en Cloudflare R2) |
| Ley 18.331 Art. 13 — deber de secreto | Audit log de accesos (Fase 1) |
| Ley 18.331 Art. 15 — derecho de supresión | Implementar `DELETE /api/companies/:id` con borrado completo de R2 + D1 + Vectorize |
| Secreto tributario | Tenant isolation obligatoria (Fase 1) |
| Retención mínima | DGI requiere conservar documentos contables 10 años. La expiración automática en R2 no debe aplicarse en períodos activos/cerrados recientes. |

**Acción pendiente:** implementar `right to erasure` completo (Fase 1) + política de retención mínima 10 años para documentos fiscales.

---

### Autenticación y sesiones

| Obligación | Implementación actual |
|------------|----------------------|
| Ley 18.331 — consentimiento informado | Se muestra Política de Privacidad en el primer login (verificar en UI) |
| Sesiones con TTL | 24 horas — cumple |
| Revocación de acceso | `DELETE FROM sessions` — cumple |
| Logs de acceso | A implementar en Fase 1 (`audit_log`) |

---

### Payroll y datos de empleados

| Dato del empleado | Clasificación legal | Tratamiento requerido |
|-------------------|--------------------|-----------------------|
| Nombre + CI | Datos personales (Ley 18.331) | Solo accesibles por usuarios del tenant con role `accountant`+ |
| Salario | Dato sensible + secreto tributario | Cifrado en reposo; PII sanitization antes de enviar a IA |
| FONASA (datos de salud) | Dato especialmente protegido (Art. 18 Ley 18.331) | No enviar nunca al modelo; calcular localmente |
| CI del empleado | Dato identificable | Anonimizar en logs; redactar en análisis IA |

**Acción requerida:** extender el módulo de PII Sanitization para reconocer y redactar sueldos y datos de empleados en el contexto de payroll.

---

### Conciliación bancaria y cuentas

| Obligación | Implementación requerida |
|------------|-------------------------|
| Ley 18.331 — dato sensible financiero | Número de cuenta cifrado (AES-256-GCM) en D1 |
| Ley 19.574 — AML | Alertas en transacciones > USD 10.000 o patrones sospechosos (Fase 4D) |
| BCU regulación futura (AISP) | Arquitectura abstracta para conector open banking (Fase 4C) |
| Secreto bancario (Ley 15.322 Art. 25) | Los datos bancarios de un cliente no pueden compartirse con otro cliente del mismo estudio — `tenant_id` aislado |

---

### Open Banking (Fase 4C — futuro)

| Requisito BCU (anticipado) | Acción preparatoria hoy |
|---------------------------|------------------------|
| Registro como AISP | Documentar arquitectura de seguridad (este documento) |
| Certificado digital para autenticación | Planificar integración con Cloudflare Access + certificados mTLS |
| Auditoría de seguridad | Implementar Fase 1 completa (tenant isolation + audit log) |
| Política de privacidad para datos financieros | Redactar addendum a la política de privacidad actual |
| Consentimiento explícito del titular de la cuenta | Diseñar flujo de consentimiento con timestamp + IP (similar a `client_approvals`) |
| Expiración de consentimientos (90 días típico) | Campo `consent_expiry` en `openbanking_connections` |

---

## Clasificación de datos por sensibilidad

### Nivel 1 — Público

No tiene restricciones especiales.

- Normativa DGI/BPS (Decretos, T.O., Circulares)
- Fechas de vencimientos fiscales
- Tarifas IRPF, BPC, SMN vigentes

### Nivel 2 — Confidencial del tenant

Accesible solo por usuarios del tenant con el rol correcto. No puede salir del tenant.

- Datos de empresas clientes (razón social, RUT, actividad)
- Documentos del período fiscal
- Análisis e informes generados
- Movimientos bancarios categorizados

### Nivel 3 — Datos personales (Ley 18.331)

Requieren base legal, consentimiento o interés legítimo. Derecho de acceso, rectificación y supresión.

- CI y datos de empleados
- Email del usuario (mínimo necesario para OTP)
- IP address en sesiones y audit log
- Datos de facturación

### Nivel 4 — Datos especialmente sensibles

Tratamiento más estricto. No procesar con IA sin anonimización completa.

- Datos de salud de empleados (cobertura FONASA, licencias médicas)
- Datos biométricos (si se agrega firma electrónica)
- Datos de condición migratoria

### Nivel 5 — Secreto tributario (Art. 47 Código Tributario)

Máxima protección. Prohibición legal de compartir. Requiere autorización expresa del titular.

- Información fiscal identificable de empresas
- Declaraciones juradas
- Resultados de inspecciones DGI

---

## Checklist de compliance por nueva feature

Antes de implementar cualquier feature nueva, verificar:

- [ ] ¿Procesa datos personales? → Base legal requerida (contrato, consentimiento, interés legítimo)
- [ ] ¿Procesa datos financieros? → Cifrado en reposo + cifrado en tránsito + audit log
- [ ] ¿Envía datos a Workers AI? → PII sanitization obligatoria
- [ ] ¿Almacena credentials externas? → Cifrado AES-256-GCM + Worker Secret como clave
- [ ] ¿Permite al contador acceder a datos del cliente? → Consentimiento explícito del cliente documentado
- [ ] ¿Crea nuevos tipos de logs? → Definir período de retención y derecho de supresión
- [ ] ¿Procesa transacciones financieras > USD 10.000? → Alerta AML automática
- [ ] ¿Se activa desde el portal del cliente? → Verificar que no haya acceso cruzado entre clientes
- [ ] ¿Genera documentos con firma digital? → Hash del documento almacenado para no-repudio

---

## Residencia de datos (Data Residency)

### Situación actual con Cloudflare

| Servicio | Región de datos | ¿Configurable? |
|----------|----------------|---------------|
| Cloudflare D1 | Por defecto: región más cercana al Worker. Configurable con `location_hint: "WNAM"/"EEUR"/"SAF"/"APAC"/"OC"` | ✅ Sí |
| Cloudflare R2 | Global por defecto. Jurisdicción `EU` disponible. | ✅ Sí (EU jurisdiction) |
| Cloudflare Vectorize | Region del account | ⚠️ Limitado |
| Workers AI | Borde global (inferencia distribuida) | ❌ No configurable por región |

### Recomendación URCDP

La Ley 18.331 permite transferir datos al exterior si el destino tiene "nivel adecuado de protección" o existe contrato de transferencia. Cloudflare como procesador de datos tiene certificación Privacy Shield equivalente y cláusulas contractuales estándar. **La transferencia a Workers AI es aceptable bajo el marco actual** dado que los datos pasan por PII sanitization antes y nunca se persiste información identificable en el modelo.

**Acción recomendada:** agregar en los Términos de Servicio y Política de Privacidad de Adviser la declaración de uso de Cloudflare Workers AI para procesamiento de datos anonimizados, con referencia explícita a la certificación de Cloudflare bajo GDPR (aplicable por analogía con Ley 18.331 según URCDP).

---

## Contactos regulatorios

| Organismo | Web | Relevancia |
|-----------|-----|-----------|
| DGI — Dirección General Impositiva | dgi.gub.uy | Normativa tributaria, e-Factura, secreto tributario |
| BPS — Banco de Previsión Social | bps.gub.uy | Nómina, FONASA, cobertura social |
| BCU — Banco Central del Uruguay | bcu.gub.uy | Sistema de pagos, open banking, entidades financieras |
| URCDP — Unidad Reguladora | urcdp.gub.uy | Datos personales, Ley 18.331 |
| UAFIU — Unidad de Información y Análisis Financiero | uafiu.gub.uy | Prevención de lavado de activos |
| IMPO — Información y Publicaciones Oficiales | impo.com.uy | Texto completo de leyes y decretos |

---

## Checklist de cumplimiento

### Ley 18.331 (URCDP) — Datos personales
- [x] PII Sanitization (CI, RUT, montos) antes de enviar a Workers AI
- [x] Datos personales no persisten en logs ni en vectores
- [x] Sesiones con TTL revocables server-side
- [ ] `right to erasure`: `DELETE /api/companies/:id` borra R2 + D1 + Vectorize (Fase 1)
- [ ] Audit log de accesos a datos personales implementado (Fase 1)
- [ ] Política de privacidad con cláusula de transferencia a Cloudflare redactada

### Art. 47 Código Tributario — Secreto tributario
- [x] PII sanitization activa en todas las consultas al LLM
- [x] Tenant isolation en endpoints — datos de un tenant no accesibles por otro
- [ ] Hardening completo de `tenant_id` en todos los modelos (Fase 1)
- [ ] Audit log de accesos a información fiscal implementado (Fase 1)

### Datos financieros — Cifrado en reposo
- [ ] Número de cuenta bancaria cifrado con AES-256-GCM (Fase 4A)
- [ ] Tokens OAuth cifrados con AES-256-GCM (Fase 2)
- [ ] Certificado digital DGI (`cfe_configs.certificado_b64`) cifrado en reposo (Fase 3)
- [ ] Cookies de portales DGI/BPS cifradas con AES-256-GCM (Fase 3 - DGI/BPS portal)

### Ley 19.574 (UAFIU) — Anti-lavado
- [ ] Alertas automáticas para transacciones >USD 10.000 implementadas (Fase 4D)
- [ ] Feature flag `aml_screening_enabled` disponible para activación por tenant
- [ ] Proceso interno de reporte UAFIU documentado

### BCU — Preparación Open Banking
- [ ] Interfaz `OpenBankingConnector` abstracta implementada (Fase 4C)
- [ ] Arquitectura de seguridad documentada para auditoría
- [ ] Proceso de registro BCU como AISP preparado para cuando el marco esté vigente
- [ ] Política de consentimiento con expiración de 90 días diseñada

### Retención de documentos
- [ ] Política de retención mínima de 10 años para documentos fiscales implementada en R2
- [ ] Expiración automática desactivada para períodos cerrados recientes
