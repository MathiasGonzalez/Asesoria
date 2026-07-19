# Tech Spec: Notificaciones Inteligentes Multi-Canal

## Stack

Worker Hono + D1 + **Cloudflare Queues** (procesamiento asíncrono) + **Cloudflare Cron Triggers** (escaneo diario) + Email (Send Email binding) + WhatsApp Business API (HTTP externo) + Web Push API (VAPID).

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tablas `notification_preferences`, `notification_log`, `notification_subscriptions` |
| `EMAIL_SEND` | Send Email | Canal email |
| `NOTIFICATION_QUEUE` | Queue | Cola de procesamiento asíncrono de notificaciones |

```jsonc
// wrangler.jsonc
"queues": {
  "producers": [{ "binding": "NOTIFICATION_QUEUE", "queue": "adviser-notifications" }],
  "consumers": [{ "queue": "adviser-notifications", "max_batch_size": 50, "max_retries": 3 }]
},
"triggers": {
  "crons": ["0 11 * * *"]   // 8 AM UTC-3 diario (hora Uruguay)
}
```

### Secrets adicionales

| Secret | Descripción |
|--------|-------------|
| `WHATSAPP_TOKEN` | Meta Cloud API bearer token |
| `WHATSAPP_PHONE_ID` | ID del número de WhatsApp Business |
| `VAPID_PRIVATE_KEY` | Clave privada VAPID para Web Push |
| `VAPID_PUBLIC_KEY` | Clave pública VAPID (expuesta al frontend) |

## Estructura de archivos

```
src/
├── routes/notifications.ts          # GET/PUT preferences, POST subscribe, GET log
├── services/notification-sender.ts  # Envío por canal (email/whatsapp/push)
├── queues/notification-consumer.ts  # Handler del Queue consumer
└── scheduled/fiscal-reminders.ts   # Cron: escaneo diario de vencimientos
```

## Esquema D1

Migración: `migrations/0012_notifications.sql`

```sql
CREATE TABLE notification_preferences (
  id               TEXT PRIMARY KEY,
  user_id          TEXT UNIQUE NOT NULL,
  tenant_id        TEXT NOT NULL,
  channel_email    INTEGER DEFAULT 1,
  channel_whatsapp INTEGER DEFAULT 0,
  channel_push     INTEGER DEFAULT 1,
  whatsapp_number  TEXT,
  quiet_from       INTEGER,   -- hora 0-23
  quiet_to         INTEGER,
  updated_at       INTEGER
);

CREATE TABLE notification_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  tenant_id  TEXT,
  type       TEXT,
  channel    TEXT,
  recipient  TEXT,
  subject    TEXT,
  status     TEXT,
  metadata   TEXT,
  sent_at    INTEGER
);
CREATE INDEX idx_notif_log_tenant ON notification_log(tenant_id, sent_at DESC);

CREATE TABLE notification_subscriptions (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  endpoint  TEXT NOT NULL,
  p256dh    TEXT NOT NULL,
  auth      TEXT NOT NULL,
  created_at INTEGER
);
```

## Flujo asíncrono

```
1. Evento disparador (p.e. documento subido)
   → Worker publica en NOTIFICATION_QUEUE:
     { type: 'doc_uploaded', userId, companyId, periodId }

2. Queue consumer (notification-consumer.ts):
   → Lee preferencias del usuario de D1
   → Por cada canal habilitado:
       email    → EMAIL_SEND binding
       whatsapp → fetch Meta Cloud API con WHATSAPP_TOKEN
       push     → Web Push API con VAPID_PRIVATE_KEY
   → INSERT notification_log

3. Cron diario (fiscal-reminders.ts):
   → Consulta vencimientos de los próximos 7 días en fiscal-calendar service
   → Por cada empresa/usuario afectado:
     → Publica en NOTIFICATION_QUEUE con type: 'fiscal_due'
```

## Creación de la Queue

```bash
npx wrangler queues create adviser-notifications
npx wrangler queues create adviser-notifications-develop
```

## Feature flag

`notifications_enabled` — cuando está deshabilitado, los endpoints devuelven respuesta vacía y el cron no envía notificaciones.
