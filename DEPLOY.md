# Guía de Deploy — Adviser

Pasos completos para configurar Cloudflare, GitHub y dejar el sistema corriendo en producción y en el ambiente `develop`.

---

## Prerrequisitos

| Herramienta | Versión mínima |
|-------------|---------------|
| Node.js | 20 |
| npm | incluido con Node 20 |
| Wrangler CLI | incluido en `devDependencies` (`npx wrangler`) |
| Cuenta Cloudflare | plan Free alcanza |
| Cuenta GitHub | para CI/CD |
| Cuenta Resend (opcional) | solo si no usás el Email Send binding de Cloudflare |

---

## 1. Clonar e instalar

```bash
git clone https://github.com/MathiasGonzalez/Asesoria.git
cd Asesoria
npm install
```

---

## 2. Autenticarse en Cloudflare

```bash
npx wrangler login
```

Esto abre el navegador. Autorizá Wrangler en tu cuenta Cloudflare.  
Verificá que quedó autenticado:

```bash
npx wrangler whoami
```

Anotá el **Account ID** que aparece — lo vas a necesitar más adelante.

---

## 3. Crear recursos D1 (base de datos)

### Producción

```bash
npx wrangler d1 create advisor_uy_db
```

La respuesta muestra algo como:

```
✅ Successfully created DB 'advisor_uy_db'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copiá ese `database_id` y reemplazá `REPLACE_WITH_D1_DATABASE_ID` en `wrangler.jsonc`:

```jsonc
// wrangler.jsonc — sección d1_databases (producción)
{
  "binding": "DB",
  "database_name": "advisor_uy_db",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",  // ← acá
  "migrations_dir": "./migrations"
}
```

### Ambiente develop

```bash
npx wrangler d1 create advisor_uy_db_develop
```

Copiá ese `database_id` y reemplazá `REPLACE_WITH_DEVELOP_D1_DATABASE_ID` en `wrangler.jsonc`:

```jsonc
// wrangler.jsonc — sección env.develop > d1_databases
{
  "binding": "DB",
  "database_name": "advisor_uy_db_develop",
  "database_id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",  // ← acá
  "migrations_dir": "./migrations"
}
```

---

## 4. Crear índices Vectorize

### Producción

```bash
npx wrangler vectorize create advisor-uy-index --dimensions=768 --metric=cosine
```

### Ambiente develop

```bash
npx wrangler vectorize create advisor-uy-index-develop --dimensions=768 --metric=cosine
```

> Los nombres `advisor-uy-index` y `advisor-uy-index-develop` ya están configurados en `wrangler.jsonc`. No hace falta editar nada.

---

## 5. Dominio personalizado (si ya tenés un dominio en Cloudflare)

Si tu dominio ya está activo en Cloudflare (zona con nameservers apuntando a Cloudflare), podés asignarlo al Worker y usar el binding de Email Send nativo — sin depender de `workers.dev` ni de Resend.

### 5.1 Agregar rutas al Worker en `wrangler.jsonc`

Edita `wrangler.jsonc` y agregá la sección `routes` dentro de la configuración raíz (producción):

```jsonc
// wrangler.jsonc — nivel raíz (producción)
{
  "routes": [
    { "pattern": "tudominio.com/*", "zone_name": "tudominio.com" },
    { "pattern": "www.tudominio.com/*", "zone_name": "tudominio.com" }
  ]
}
```

> **Alternativa — dominio personalizado sin `routes`:** en el dashboard de Cloudflare → **Workers & Pages** → tu Worker → pestaña **Settings** → **Domains & Routes** → *Add Custom Domain* → escribí el subdominio (ej. `app.tudominio.com`). Cloudflare crea el registro DNS automáticamente y emite el certificado TLS.

Para el ambiente `develop`, agregá rutas dentro de `env.develop`:

```jsonc
// wrangler.jsonc — dentro de env.develop
{
  "routes": [
    { "pattern": "develop.tudominio.com/*", "zone_name": "tudominio.com" }
  ]
}
```

### 5.2 Verificar el DNS

Confirmá que el dominio o subdominio tiene un registro **A / CNAME con proxy naranja (☁)** en Cloudflare. Los Workers con `routes` requieren que el tráfico pase por el proxy de Cloudflare.

```bash
# Verificar que el dominio está en tu cuenta
npx wrangler whoami
# El Account ID debe coincidir con la zona del dominio
```

### 5.3 Habilitar Email Routing para usar el binding `EMAIL_SEND`

1. En el **Dashboard de Cloudflare** → **Email** → **Email Routing** → seleccioná tu dominio.
2. Hacé clic en **Enable Email Routing** y seguí los pasos para agregar los registros MX y SPF que Cloudflare indica (se agregan en tu zona automáticamente).
3. En la pestaña **Settings** de Email Routing, habilitá **Send emails** para el dominio.
4. Una vez activo, el binding `EMAIL_SEND` en `wrangler.jsonc` ya está configurado — solo necesitás definir el secreto `EMAIL_FROM` con una dirección del dominio verificado:

```bash
npx wrangler secret put EMAIL_FROM
# Ingresá: noreply@tudominio.com

npx wrangler secret put EMAIL_FROM --env develop
# Ingresá: noreply@tudominio.com
```

> Con Email Routing activo en tu dominio, podés usar la **Opción A** de la sección de email (binding nativo) sin necesitar cuenta Resend.

---

## 6. Configurar email

El Worker soporta dos métodos para enviar emails OTP. Usá uno de los dos:

### Opción A — Cloudflare Email Send binding (recomendado)

Requiere tener un dominio verificado en **Cloudflare Email Routing**.

1. En el dashboard de Cloudflare → **Email** → **Email Routing** → habilitá el dominio de envío.
2. En `wrangler.jsonc` la sección `send_email` ya tiene el binding `EMAIL_SEND` configurado.
3. Solo necesitás configurar el secreto `EMAIL_FROM`:

```bash
npx wrangler secret put EMAIL_FROM
# Ingresá: noreply@tudominio.com
```

Para develop:

```bash
npx wrangler secret put EMAIL_FROM --env develop
```

### Opción B — Resend API (fallback sin dominio propio)

1. Creá una cuenta en [resend.com](https://resend.com) y generá una API key.
2. Verificá un dominio o usá el dominio de sandbox de Resend.

```bash
npx wrangler secret put EMAIL_API_KEY
# Ingresá: re_xxxxxxxxxxxxxxxxxxxxxxxx

npx wrangler secret put EMAIL_FROM
# Ingresá: noreply@tudominio.com
```

Para develop:

```bash
npx wrangler secret put EMAIL_API_KEY --env develop
npx wrangler secret put EMAIL_FROM --env develop
```

> El Worker detecta automáticamente cuál método usar: si `EMAIL_SEND` binding está disponible lo usa; si no, cae al cliente Resend con `EMAIL_API_KEY`.

---

## 7. Aplicar migraciones a la base de datos

### Local (para desarrollo)

```bash
npm run db:migrate:local
```

Esto aplica las tres migraciones (`0000_init.sql`, `0001_auth.sql`, `0002_terms_consents.sql`) sobre la D1 local emulada por Wrangler.

### Remoto — Producción

```bash
npx wrangler d1 migrations apply advisor_uy_db --remote
```

### Remoto — Develop

```bash
npx wrangler d1 migrations apply advisor_uy_db_develop --remote --env develop
```

---

## 8. Build y primer deploy manual

```bash
# Build del frontend Astro + check de tipos TypeScript
npm run build

# Deploy producción
npm run deploy

# Deploy develop
npx wrangler deploy --env develop
```

Wrangler imprime la URL pública del Worker al finalizar, por ejemplo:  
`https://adviser.tuusuario.workers.dev`

---

## 9. CI/CD con GitHub Actions

El workflow `.github/workflows/deploy.yml` ya está configurado:

- **Push a `main`** → aplica migraciones + deploya en producción
- **Push a `develop`** → aplica migraciones + deploya en ambiente develop

### Secrets requeridos en el repositorio

En GitHub → **Settings → Secrets and variables → Actions**, agregá:

| Secret | Cómo obtenerlo |
|--------|---------------|
| `CLOUDFLARE_API_TOKEN` | Dashboard Cloudflare → **My Profile → API Tokens → Create Token** → usar plantilla *Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard Cloudflare → página principal → columna derecha, o `npx wrangler whoami` |

#### Permisos mínimos para el API Token

Al crear el token en Cloudflare, asegurate de incluir:

| Permiso | Tipo |
|---------|------|
| Workers Scripts — Edit | Account |
| Workers Routes — Edit | Zone (o Account) |
| D1 — Edit | Account |
| Vectorize — Edit | Account |
| Account Settings — Read | Account |

---

## 10. Desarrollo local

```bash
npm run dev
```

Levanta el Worker con Wrangler en `http://127.0.0.1:8787`. Las bindings de D1 y AI se emulan localmente; Vectorize requiere llamadas remotas (necesitás estar autenticado con `wrangler login`).

Para correr solo el frontend Astro (sin Worker):

```bash
npm run dev:web
```

---

## 11. Ingestión de documentos

Una vez desplegado, cargá normativa al corpus RAG vía la API de ingestión autenticada. Consultá [`features/document-ingestion.md`](./features/document-ingestion.md) para el formato de payload y endpoints.

---

## Checklist de deploy

- [ ] `npm install` completado
- [ ] `wrangler login` autenticado
- [ ] D1 producción creada — `database_id` en `wrangler.jsonc`
- [ ] D1 develop creada — `database_id` en `wrangler.jsonc`
- [ ] Vectorize `advisor-uy-index` creado
- [ ] Vectorize `advisor-uy-index-develop` creado
- [ ] *(Opcional)* Rutas de dominio personalizado configuradas en `wrangler.jsonc`
- [ ] *(Opcional)* Email Routing habilitado en el dominio
- [ ] `EMAIL_FROM` configurado (producción y develop)
- [ ] `EMAIL_API_KEY` configurado si no usás Email Send binding
- [ ] Migraciones aplicadas remotamente (producción y develop)
- [ ] `npm run build` sin errores
- [ ] Deploy inicial exitoso (`npm run deploy`)
- [ ] Secrets `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` en GitHub
- [ ] Push a `main` activa el pipeline correctamente
