# Fase 2 — Document Hub con OAuth Externo

## Objetivo

La mayoría de las empresas uruguayas **ya tienen sus documentos en Google Drive, Microsoft OneDrive/SharePoint o Dropbox**. La app hoy solo permite importar Google Docs y Sheets públicos (sin login). Esta fase agrega autenticación OAuth 2.0 real para acceder a documentos privados de los proveedores más usados en el mercado.

**Mercado objetivo:**
- Google Workspace — dominante en PyMEs y estudios contables uruguayos (estimado 60-70% del mercado SMB)
- Microsoft 365 / OneDrive / SharePoint — empresas medianas y grandes (bancos, corporativos)
- Dropbox — uso residual en algunas empresas y freelancers

---

## Situación actual vs. objetivo

| Funcionalidad | Hoy | Fase 2 |
|---------------|-----|--------|
| Google Docs / Sheets públicos | ✅ Importación por URL pública | — |
| Google Drive privado | ❌ | ✅ OAuth 2.0, acceso a carpetas y archivos |
| Google Sheets privados | ❌ | ✅ Exportación CSV desde hojas privadas |
| Microsoft OneDrive | ❌ | ✅ OAuth 2.0 con Microsoft Identity Platform |
| SharePoint (empresas) | ❌ | ✅ Acceso a bibliotecas de documentos |
| Dropbox | ❌ | ✅ OAuth 2.0, importación de archivos |
| OCR en PDFs | ❌ (manual) | ✅ Workers AI OCR automático |

---

## Paso 2.1 — Infraestructura OAuth en Cloudflare Workers

### Diseño arquitectural (sin servidor dedicado)

Cloudflare Workers maneja el flujo OAuth completo:

```
Usuario → Adviser Worker → [Redirect a Google/Microsoft/Dropbox]
                              ↓ (usuario da permisos)
Google/Microsoft/Dropbox → callback URL en Adviser Worker
                              ↓
Adviser Worker: intercambia code → tokens (access_token + refresh_token)
                              ↓
Adviser Worker: cifra tokens con AES-256-GCM → guarda en D1
```

### Tabla D1 para tokens OAuth

```sql
-- migrations/0017_oauth_tokens.sql
CREATE TABLE oauth_connections (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  provider        TEXT NOT NULL,    -- google | microsoft | dropbox
  provider_user_id TEXT,            -- sub del usuario en el proveedor
  provider_email  TEXT,             -- email registrado en el proveedor
  access_token    TEXT NOT NULL,    -- cifrado AES-256-GCM (hex)
  refresh_token   TEXT,             -- cifrado AES-256-GCM (hex)
  token_expiry    INTEGER,          -- UNIX timestamp
  scopes          TEXT,             -- scopes concedidos (JSON array)
  connected_at    INTEGER NOT NULL,
  last_used_at    INTEGER,
  revoked         INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX idx_oauth_user_provider ON oauth_connections(user_id, provider);
CREATE INDEX idx_oauth_tenant ON oauth_connections(tenant_id);
```

### Cifrado de tokens — Worker Secret

```typescript
// src/services/oauth-crypto.ts
const OAUTH_KEY_SECRET = env.OAUTH_ENCRYPTION_KEY  // 32 bytes hex, Worker Secret

async function encryptToken(plaintext: string): Promise<string> {
  const key = await importAesKey(OAUTH_KEY_SECRET)
  const iv  = crypto.getRandomValues(new Uint8Array(12))
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext))
  return toHex(iv) + ':' + toHex(new Uint8Array(enc))
}

async function decryptToken(ciphertext: string): Promise<string> {
  const [ivHex, dataHex] = ciphertext.split(':')
  const key = await importAesKey(OAUTH_KEY_SECRET)
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(ivHex) }, key, fromHex(dataHex))
  return decoder.decode(dec)
}
```

**Nuevo Worker Secret requerido:**
```bash
npx wrangler secret put OAUTH_ENCRYPTION_KEY
# Generar con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Rutas OAuth

```
GET  /api/oauth/:provider/connect     → genera state CSRF, redirige al proveedor
GET  /api/oauth/:provider/callback    → intercambia code, guarda tokens
DELETE /api/oauth/:provider           → revoca y elimina tokens locales
GET  /api/oauth/connections           → lista conexiones activas del usuario
```

### Gestión de refresh automático

```typescript
// src/services/oauth-client.ts
async function getValidAccessToken(db: D1, connectionId: string): Promise<string> {
  const conn = await db.prepare('SELECT * FROM oauth_connections WHERE id = ?').bind(connectionId).first()
  if (conn.token_expiry < Date.now() / 1000 + 60) {
    // Token expirado o por expirar en 60s → hacer refresh
    const newTokens = await refreshOAuthToken(conn.provider, decryptToken(conn.refresh_token))
    await db.prepare(`
      UPDATE oauth_connections SET access_token = ?, token_expiry = ?, last_used_at = ?
      WHERE id = ?
    `).bind(encryptToken(newTokens.access_token), newTokens.expires_at, Date.now(), connectionId).run()
    return newTokens.access_token
  }
  return decryptToken(conn.access_token)
}
```

---

## Paso 2.2 — Integración Google Drive

### Scopes requeridos (mínimos — principio de least privilege)

```
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/spreadsheets.readonly
```

No se solicita `drive.file` ni permisos de escritura. Esto es importante para la revisión de seguridad de Google y para la confianza del usuario.

### Configuración Google Cloud Console

1. Crear proyecto OAuth en console.cloud.google.com
2. Habilitar Drive API y Sheets API
3. Configurar pantalla de consentimiento OAuth (tipo Externo, verificación necesaria para producción)
4. Redirect URI: `https://adviser.tudominio.uy/api/oauth/google/callback`
5. Agregar como Worker Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

### Endpoints de Drive

```
GET /api/drive/browse           → lista carpetas y archivos del root de Drive
GET /api/drive/browse/:folderId → lista contenido de una carpeta
GET /api/drive/import/:fileId   → importa un archivo de Drive al período activo
GET /api/drive/sync             → sincroniza una carpeta (Fase 2b)
```

### Importación por tipo de archivo

| Tipo de archivo | Estrategia de importación |
|-----------------|--------------------------|
| Google Docs (`application/vnd.google-apps.document`) | Exportar como `text/plain` via Drive API |
| Google Sheets (`application/vnd.google-apps.spreadsheet`) | Exportar como `text/csv` via Drive API |
| PDF (`application/pdf`) | Descargar binario → guardar en R2 → OCR con Workers AI (ver 2.4) |
| XLSX | Descargar binario → guardar en R2 |
| CSV / TXT | Descargar y extraer texto directamente |

### Selección de carpeta vinculada a empresa

```typescript
// Modelo: cada empresa puede tener una carpeta de Drive vinculada
ALTER TABLE companies ADD COLUMN gdrive_folder_id TEXT;
ALTER TABLE companies ADD COLUMN gdrive_folder_name TEXT;
ALTER TABLE companies ADD COLUMN oauth_connection_id TEXT; -- FK a oauth_connections
```

Al configurar la empresa, el contador selecciona la carpeta de Drive del cliente. Desde ahí, puede importar documentos con un click en lugar de buscarlos manualmente.

---

## Paso 2.3 — Integración Microsoft OneDrive / SharePoint

### Scopes requeridos (Microsoft Identity Platform / Graph API)

```
Files.Read
Files.Read.All (para SharePoint)
Sites.Read.All (para SharePoint sites)
offline_access (para refresh token)
```

### Configuración Azure AD App Registration

1. Crear App en portal.azure.com → Azure Active Directory → App Registrations
2. Tipo de cuenta: "Accounts in any organizational directory and personal Microsoft accounts"
3. Redirect URI: `https://adviser.tudominio.uy/api/oauth/microsoft/callback`
4. Generar Client Secret
5. Agregar como Worker Secrets: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` (o `common` para multi-tenant)

### Endpoints Microsoft Graph

```typescript
// Listar archivos raíz OneDrive
GET https://graph.microsoft.com/v1.0/me/drive/root/children

// Listar contenido de carpeta
GET https://graph.microsoft.com/v1.0/me/drive/items/{folder-id}/children

// Descargar contenido de archivo
GET https://graph.microsoft.com/v1.0/me/drive/items/{file-id}/content

// SharePoint — listar documentos de un site
GET https://graph.microsoft.com/v1.0/sites/{site-id}/drive/root/children
```

### Vinculación a empresas

```typescript
// Igual que Google Drive pero con provider = 'microsoft'
ALTER TABLE companies ADD COLUMN onedrive_folder_id TEXT;
ALTER TABLE companies ADD COLUMN onedrive_folder_name TEXT;
```

---

## Paso 2.4 — OCR automático con Workers AI

### Situación actual

Los PDFs subidos a R2 no tienen extracción automática de texto. El usuario debe complementar manualmente.

### Solución con Workers AI

```typescript
// src/services/ocr.ts
export async function extractTextFromPdf(
  env: Env,
  r2Key: string
): Promise<string | null> {
  const obj = await env.DOCUMENTS_BUCKET.get(r2Key)
  if (!obj) return null
  const bytes = new Uint8Array(await obj.arrayBuffer())

  // Workers AI — modelo de visión para OCR
  const result = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
    image: Array.from(bytes),
    prompt: 'Extract all text from this document. Output only the extracted text, no commentary.',
    max_tokens: 2048
  })
  return result.description?.trim() ?? null
}
```

**Nota:** Workers AI soporta input de imagen para modelos de visión. Para PDFs de múltiples páginas se puede paginar o usar Cloudflare Browser Rendering para renderizar cada página como imagen antes de pasarla al modelo.

### Integración en el pipeline de upload

1. Al subir un PDF a R2, encolar un mensaje en **Cloudflare Queues** con `{ documentId, r2Key }`.
2. Un Worker consumidor procesa la cola: llama a `extractTextFromPdf` y actualiza `tax_documents.content` en D1.
3. El frontend muestra "Procesando OCR..." y se actualiza cuando el contenido está listo (polling o SSE).

---

## Paso 2.5 — Integración Dropbox

### Scopes requeridos

```
files.metadata.read
files.content.read
```

### Configuración Dropbox App Console

1. Crear app en dropbox.com/developers con tipo "Scoped access" y acceso "Full Dropbox" o "App folder"
2. Redirect URI: `https://adviser.tudominio.uy/api/oauth/dropbox/callback`
3. Agregar como Worker Secrets: `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET`

---

## Paso 2.6 — Sincronización diferencial de carpetas

### Descripción

Una vez que se vincula una carpeta de Drive/OneDrive/Dropbox a una empresa, Adviser puede sincronizar automáticamente los nuevos documentos que aparezcan en esa carpeta.

### Implementación con Cloudflare Queues + Durable Objects

```
Cloudflare Cron Trigger (diario, o cada hora) →
  Worker: lista carpetas vinculadas →
    Por cada carpeta: consulta cambios via change token (Google: pageToken, OneDrive: deltaLink, Dropbox: cursor) →
      Si hay archivos nuevos/modificados → encola en Queue →
        Consumer Worker: descarga + guarda en R2 + extrae texto + actualiza D1
```

### Tabla para tracking de sync

```sql
CREATE TABLE folder_sync_state (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  folder_id       TEXT NOT NULL,
  sync_token      TEXT,             -- pageToken (Google) / deltaLink (MS) / cursor (Dropbox)
  last_synced_at  INTEGER,
  status          TEXT DEFAULT 'active'
);
```

---

## Entregables de la Fase 2

| Entregable | Descripción |
|------------|-------------|
| `migrations/0017_oauth_tokens.sql` | Tabla `oauth_connections` |
| `migrations/0018_folder_sync.sql` | Tabla `folder_sync_state` |
| `src/services/oauth-crypto.ts` | Cifrado/descifrado de tokens |
| `src/services/oauth-client.ts` | Refresh automático de tokens |
| `src/routes/oauth.ts` | Flujo OAuth para los 3 proveedores |
| `src/routes/drive.ts` | Browse + import desde Google Drive |
| `src/routes/onedrive.ts` | Browse + import desde OneDrive/SharePoint |
| `src/routes/dropbox.ts` | Browse + import desde Dropbox |
| `src/services/ocr.ts` | OCR de PDFs con Workers AI |
| `src/queues/ocr-consumer.ts` | Worker Queue para OCR asíncrono |
| `src/queues/sync-consumer.ts` | Worker Queue para sync diferencial |
| Worker Secrets | `OAUTH_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `DROPBOX_CLIENT_ID/SECRET` |

---

## Consideraciones de seguridad y privacidad

| Consideración | Decisión de diseño |
|---------------|-------------------|
| Los tokens OAuth son datos personales (Ley 18.331) | Cifrado AES-256-GCM antes de persistir en D1 |
| El usuario puede revocar en cualquier momento | `DELETE /api/oauth/:provider` elimina tokens de D1 y llama al revoke endpoint del proveedor |
| El contador no debería acceder a Drive del cliente sin su consentimiento | La conexión OAuth la realiza el propio cliente desde su sesión, no el contador |
| Scopes mínimos | Solo `readonly` — Adviser nunca escribe en Drive/OneDrive/Dropbox |
| Logs de acceso a documentos externos | Cada importación desde proveedor externo se registra en `audit_log` |
