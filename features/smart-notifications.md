# Feature: Notificaciones Inteligentes Multi-Canal

## Descripción

Sistema proactivo de alertas y recordatorios que notifica a contadores y clientes sobre vencimientos fiscales, documentos pendientes y estados de análisis a través de múltiples canales: email, WhatsApp Business API y notificaciones push web. Las notificaciones se personalizan según el régimen tributario de cada empresa y el rol del usuario.

## Casuística de mercado

Las multas por presentación fuera de término son uno de los principales puntos de dolor de PyMEs y estudios:

- La DGI aplica recargos automáticos desde el día 1 de vencimiento (tasa de mora + multas).
- Los estudios contables manejan docenas de clientes con vencimientos distintos según el dígito del RUT.
- El calendario fiscal uruguayo es complejo: el vencimiento exacto varía por dígito de RUT, día de la semana y feriados.
- Los clientes olvidan entregar documentos a tiempo, bloqueando el trabajo del contador.
- Las notificaciones por WhatsApp tienen tasas de apertura >90% en Uruguay vs ~30% en email — muy relevante para el segmento PyME/persona.

## Casos de uso

- **UC-120** Cinco días antes del vencimiento del IVA, el sistema envía un WhatsApp al cliente y un email al contador asignado: "Vencimiento IVA Empresa ABC — 20/04/2025 — falta adjuntar libro IVA ventas."
- **UC-121** Cuando un cliente sube los documentos solicitados en el portal, el contador recibe una notificación push en su browser: "Cliente XYZ subió 3 documentos para Marzo 2025."
- **UC-122** Si un período fiscal lleva más de 10 días en estado `draft` sin ser analizado, el sistema alerta al contador responsable.
- **UC-123** El día del vencimiento de IRAE anual, el sistema envía recordatorio diferenciado: a empresas sin consolidación lista (🔴 urgente) vs empresas ya analizadas (✅ informativo).
- **UC-124** Un usuario puede configurar sus preferencias: "solo email", "solo WhatsApp" o "ambos", y el horario de entrega preferido (8–20 h).

## Canales soportados

| Canal | Proveedor | Caso de uso principal |
|-------|-----------|----------------------|
| **Email** | Resend (ya integrado) | Vencimientos, resúmenes semanales, invitaciones |
| **WhatsApp Business** | Meta Cloud API / Twilio | Alertas urgentes, documentos pendientes |
| **Push web** | Web Push API (VAPID) | Actividad en tiempo real dentro de la app |

## Tipos de notificaciones

### Notificaciones de vencimiento fiscal

| Trigger | Canal | Anticipación |
|---------|-------|-------------|
| IVA mensual próximo | Email + WhatsApp | D-7, D-3, D-0 |
| BPS / SUNA | Email | D-5, D-1 |
| IRAE anticipo | Email | D-7 |
| Monotributo | WhatsApp | D-5 |
| IRPF anual | Email | D-30, D-7 |
| Certificado DGI vence | Email | D-30, D-7 |

### Notificaciones de actividad en plataforma

| Trigger | Canal | Destinatario |
|---------|-------|-------------|
| Cliente sube documento | Push + email | Contador asignado |
| Análisis IA completado | Push | Usuario que lo ejecutó |
| Período sin analizar > 10 días | Email | Contador asignado |
| Documento solicitado vence D-3 | WhatsApp + email | Cliente |
| Informe listo para aprobar | Email + WhatsApp | Cliente |

## Modelo de datos

```sql
notification_preferences (
  id, user_id, tenant_id,
  channel_email    INTEGER DEFAULT 1,
  channel_whatsapp INTEGER DEFAULT 0,
  channel_push     INTEGER DEFAULT 1,
  whatsapp_number  TEXT,
  quiet_hours_from INTEGER,   -- hora 0-23
  quiet_hours_to   INTEGER,
  updated_at
)

notification_log (
  id, user_id, tenant_id,
  type         TEXT,    -- fiscal_due | doc_requested | analysis_done | etc.
  channel      TEXT,    -- email | whatsapp | push
  recipient    TEXT,
  subject      TEXT,
  status       TEXT,    -- sent | delivered | failed | bounced
  metadata     TEXT,    -- JSON con detalles (company_id, period_id, etc.)
  sent_at      TIMESTAMP
)

notification_subscriptions (
  id, user_id,
  endpoint     TEXT,    -- Push API endpoint
  p256dh       TEXT,    -- Clave pública VAPID
  auth         TEXT,    -- Secreto VAPID
  created_at
)
```

## Arquitectura técnica

Las notificaciones se procesan de forma asíncrona usando **Cloudflare Queues** para no bloquear los endpoints principales:

```
Evento disparador (API endpoint)
  → publica mensaje en Queue ("notification:fiscal_due", payload)
    → Worker consumer procesa la Queue
      → evalúa preferencias del usuario
      → envía por cada canal habilitado
        → registra en notification_log
```

### Scheduled triggers para vencimientos

Un **Cron Trigger** (`0 8 * * *` — 8 AM UTC-3 diario) escanea los vencimientos próximos:

```typescript
// src/scheduled/fiscal-reminders.ts
export async function checkFiscalDueDates(env: Env) {
  const upcoming = await getUpcomingDueDates(env.DB, { withinDays: 7 })
  for (const due of upcoming) {
    await env.NOTIFICATION_QUEUE.send({ type: 'fiscal_due', ...due })
  }
}
```

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`    | `/api/notifications/preferences` | Lee preferencias del usuario |
| `PUT`    | `/api/notifications/preferences` | Actualiza preferencias y número de WhatsApp |
| `POST`   | `/api/notifications/push/subscribe` | Registra suscripción Push (VAPID) |
| `DELETE` | `/api/notifications/push/subscribe` | Elimina suscripción Push |
| `GET`    | `/api/notifications/log` | Historial de notificaciones enviadas |
| `POST`   | `/api/notifications/test` | Envía notificación de prueba (dev/admin) |

## Página

- `/app/configuracion/notificaciones` — Preferencias de canal, horarios y número de WhatsApp

## Mejoras futuras (v2)

- SMS como canal de respaldo para WhatsApp
- Notificaciones por Telegram Bot
- Digest semanal: resumen de actividad del estudio los lunes
- Integración con Google Calendar: agregar vencimientos como eventos con recordatorio
- Smart throttling: si un cliente ya fue alertado 3 veces, escalar al contador titular

## Checklist de implementación

### Prerequisito
- [ ] `fiscal-calendar.md` implementado (vencimientos calculados)
- [ ] `multi-user-teams.md` implementado (rol y asignaciones de usuario)

### Base de datos
- [ ] Tabla `notification_preferences` creada con canales y horarios de silencio
- [ ] Tabla `notification_log` creada para historial de envíos
- [ ] Tabla `notification_subscriptions` creada para Web Push (VAPID endpoints)

### Infraestructura
- [ ] Cloudflare Queue `NOTIFICATION_QUEUE` creado y binding configurado
- [ ] Cron Trigger diario (`0 8 * * *` — 8 AM UTC-3) configurado en `wrangler.jsonc`
- [ ] Worker Secret `WHATSAPP_TOKEN` (Meta Cloud API / Twilio) configurado
- [ ] VAPID key pair generado y configurado como Worker Secrets

### Backend
- [ ] `GET /api/notifications/preferences` — lee preferencias del usuario
- [ ] `PUT /api/notifications/preferences` — actualiza canales y número de WhatsApp
- [ ] `POST /api/notifications/push/subscribe` — registra suscripción Web Push
- [ ] `DELETE /api/notifications/push/subscribe` — elimina suscripción Push
- [ ] `GET /api/notifications/log` — historial de notificaciones
- [ ] `POST /api/notifications/test` — notificación de prueba (dev/admin)
- [ ] `src/scheduled/fiscal-reminders.ts` — escanea vencimientos próximos y encola mensajes
- [ ] `src/queues/notification-consumer.ts` — consumer que envía por canal y registra en log
- [ ] Envío de email via Resend (ya integrado) para notificaciones
- [ ] Integración con WhatsApp Business API (Meta Cloud API o Twilio)
- [ ] Envío de Web Push con VAPID

### Frontend
- [ ] `/app/configuracion/notificaciones` — preferencias de canal, horarios, número de WhatsApp

### Validación
- [ ] UC-120: WhatsApp D-5 antes de vencimiento IVA + email al contador asignado
- [ ] UC-121: notificación push al contador cuando cliente sube documentos
- [ ] UC-122: alerta al contador cuando período lleva >10 días en `draft`
- [ ] UC-123: recordatorio de IRAE anual diferenciado según estado del período
- [ ] UC-124: preferencias de canal respetadas (solo email / solo WhatsApp / ambos)
- [ ] Horario de silencio (`quiet_hours`) respetado: notificaciones no enviadas fuera del horario
