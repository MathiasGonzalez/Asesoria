# Asesoría DGI/BPS en Cloudflare

MVP full-stack para asesoramiento regulatorio uruguayo con Cloudflare Workers, D1, Vectorize y Workers AI.

## Guía de ejecución paso a paso (terminal)

1. **Instalar dependencias**
   ```bash
   npm install
   ```

2. **Autenticarse en Cloudflare**
   ```bash
   npx wrangler login
   ```

3. **Crear base D1**
   ```bash
   npx wrangler d1 create uy_tax_db
   ```
   - Copiar el `database_id` retornado y reemplazar `REPLACE_WITH_D1_DATABASE_ID` en `/home/runner/work/Asesoria/Asesoria/wrangler.jsonc`.

4. **Crear índice Vectorize**
   ```bash
   npx wrangler vectorize create uy-tax-index --dimensions=768 --metric=cosine
   ```

5. **Aplicar migraciones localmente**
   ```bash
   npm run db:migrate:local
   ```

6. **Build local**
   ```bash
   npm run build
   ```

7. **Deploy manual inicial**
   ```bash
   npm run deploy
   ```

## Configuración de secretos en GitHub Actions

Desde el repositorio en GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

Crear:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Primer despliegue vía CI/CD

1. Hacer commit y push a `main`.
2. Verificar workflow en **Actions → Deploy Worker & Static Assets**.
3. El pipeline ejecuta en orden:
   - `npm ci`
   - `npm run build`
   - `wrangler d1 migrations apply uy_tax_db --remote`
   - `wrangler deploy`
