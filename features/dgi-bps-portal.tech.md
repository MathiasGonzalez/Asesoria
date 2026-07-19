# Tech Spec: Automatización de Portales DGI / BPS

## Stack

Worker Hono + D1 + **Cloudflare Browser Rendering API** (`@cloudflare/puppeteer`). El Worker usa el binding `BROWSER` para lanzar instancias de Puppeteer directamente en el edge, sin infraestructura extra.

## Arquitectura

```
Adviser Worker (TypeScript/Hono)
  └─→ Cloudflare Browser Rendering (binding BROWSER)
        └─→ DGI SIGA / BPS SUNA (internet)

Adviser Worker
  └─→ D1 (tabla portal_sessions — cookies cifradas AES-256-GCM)
```

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `DB` | D1 | Tabla `portal_sessions` |
| `BROWSER` | Browser Rendering | Instancias de Puppeteer para automatizar portales |
| `PORTAL_ENCRYPTION_KEY` | Worker Secret | Clave AES-256-GCM (64-char hex) para cifrar cookies |

```jsonc
// wrangler.jsonc — ya incluido:
"browser": {
  "binding": "BROWSER"
}

// Secrets (set via `wrangler secret put`):
//   PORTAL_ENCRYPTION_KEY – 64-char hex string (32 bytes AES-256)
//   Generar: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Estructura de archivos

```
src/
├── services/portalBrowser.ts   # PortalBrowserService — login + runTask vía Puppeteer
├── services/portalCrypto.ts    # encryptData / decryptData — AES-256-GCM Web Crypto
└── index.ts                    # Rutas /api/portal/*
migrations/
└── 0008_portal_sessions.sql   # Tabla portal_sessions
```

## Esquema D1

Migración: `migrations/0008_portal_sessions.sql`

```sql
CREATE TABLE portal_sessions (
  id                      TEXT    PRIMARY KEY,
  company_id              TEXT    NOT NULL,
  user_id                 TEXT    NOT NULL,
  portal                  TEXT    NOT NULL CHECK(portal IN ('dgi', 'bps')),
  encrypted_cookies       TEXT    NOT NULL,   -- base64 AES-256-GCM ciphertext
  cookies_iv              TEXT    NOT NULL,   -- base64 12-byte GCM IV
  session_established_at  INTEGER NOT NULL,
  last_used_at            INTEGER,
  created_at              INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at              INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(company_id, portal)
);
```

## API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/portal/:portal/connect` | Login al portal; guarda cookies cifradas |
| `GET` | `/api/portal/:portal/status?company_id=` | Verifica si hay sesión activa |
| `POST` | `/api/portal/:portal/task` | Ejecuta una tarea usando la sesión almacenada |
| `DELETE` | `/api/portal/:portal/disconnect` | Elimina la sesión almacenada |

`:portal` acepta `dgi` o `bps`.

### POST `/api/portal/:portal/connect`
```json
// Request body
{ "company_id": "uuid", "username": "...", "password": "..." }

// Response 200
{ "ok": true, "message": "Sesión DGI establecida correctamente." }

// Response 422 — CAPTCHA detectado
{ "error": "El portal requiere resolver un CAPTCHA..." }

// Response 422 — credenciales inválidas
{ "error": "Credenciales inválidas o error en el portal." }
```

### POST `/api/portal/:portal/task`
```json
// Request body
{
  "company_id": "uuid",
  "task": "consulta_estado_cuenta" | "descarga_constancia" | "consulta_deuda"
}

// Response 200
{ "ok": true, "task": "consulta_estado_cuenta", "data": { "raw_text": "..." } }

// Response 401 — sesión expirada
{ "expired": true, "error": "La sesión del portal expiró..." }
```

## Modelo de cifrado de cookies (`portalCrypto.ts`)

```
plaintext = JSON.stringify(cookies[])
key       = importKey(PORTAL_ENCRYPTION_KEY)   // AES-256-GCM, 32 bytes
iv        = crypto.getRandomValues(12 bytes)
ciphertext = AES-256-GCM(key, iv, plaintext)

Almacenado en D1:
  encrypted_cookies = base64(ciphertext)
  cookies_iv        = base64(iv)
```

La clave nunca se almacena junto a los datos cifrados. Vive solo como Worker Secret.

## PortalBrowserService

```typescript
const service = new PortalBrowserService(env.BROWSER);

// Login y obtención de cookies
const { success, cookies } = await service.login("dgi", username, password);

// Ejecución de tarea con sesión restaurada
const { success, data } = await service.runTask("dgi", cookies, "consulta_estado_cuenta");
```

### Detección de CAPTCHA

Antes de intentar el login, el servicio busca selectores de reCAPTCHA/hCAPTCHA. Si los detecta, retorna `{ success: false, error: "El portal requiere CAPTCHA..." }` sin intentar el login.

### ⚠️ Selectores pendientes de verificación

Los selectores CSS en `portalBrowser.ts` son aproximaciones derivadas de los patrones comunes de portales ASP.NET WebForms. **Deben ser verificados con DevTools** contra los portales live antes del despliegue en producción:

- DGI SIGA: `https://servicios.dgi.gub.uy/serviciosenlinea`
- BPS SUNA: `https://www.bps.gub.uy/bps/index.jsp`

Ajustar las constantes `DGI_SELECTORS`, `BPS_SELECTORS`, `DGI_TASK_URLS` y `BPS_TASK_URLS` en `src/services/portalBrowser.ts`.

## Feature flag

`portal_automation_enabled` — protege todos los endpoints `/api/portal/*`. Desactivado por defecto. Activar por tenant desde la consola admin o directamente en D1:

```sql
INSERT INTO feature_flags (tenant_id, name, enabled)
VALUES (NULL, 'portal_automation_enabled', 1);
```

## Limitaciones del Browser Rendering API

- Máximo **2 instancias simultáneas** en el plan Workers Paid.
- Las sesiones de browser son **efímeras** (se cierran después de cada request). Las cookies se persisten en D1 para sobrevivir entre requests.
- Requiere el plan **Cloudflare Workers Paid** o superior.
- Si la concurrencia resulta insuficiente en producción, escalar al patrón Container (mismo patrón que UruFactura) usando un Container Node.js con Playwright y Durable Objects por empresa.

## Escalado a Container (opcional)

Si Browser Rendering no es suficiente (concurrencia, sesiones de larga duración, proxies residenciales), crear un Container `AdviserBrowser` siguiendo el mismo patrón de `UruFactura`:

```
Adviser Worker
  └─→ AdviserBrowser Container (Node.js + Playwright, DO por empresa)
        └─→ DGI SIGA / BPS SUNA
```

El Worker existente ya tiene la lógica de negocio completa; solo cambiaría el transporte en `PortalBrowserService`.

## Despliegue

```bash
# 1. Configurar el secret de cifrado
wrangler secret put PORTAL_ENCRYPTION_KEY
# (ingresar una cadena hex de 64 caracteres)

# 2. Aplicar la migración de D1
wrangler d1 migrations apply DB --remote

# 3. Habilitar Browser Rendering en el dashboard de Cloudflare
#    Workers & Pages → tu Worker → Settings → Browser Rendering → Enable

# 4. Desplegar
wrangler deploy
```
