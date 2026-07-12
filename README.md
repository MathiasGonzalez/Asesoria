# Adviser — Asesoría Regulatoria Inteligente para Uruguay

[![Cumplimiento Art. 47 Código Tributario](https://img.shields.io/badge/Art.%2047%20Cód.%20Tributario-Secreto%20Tributario-blue?style=flat-square)](https://www.impo.com.uy/bases/codigo-tributario/14306-1991/47)
[![URCDP — Ley 18.331](https://img.shields.io/badge/URCDP-Ley%2018.331%20Datos%20Personales-green?style=flat-square)](https://www.impo.com.uy/bases/leyes/18331-2008)
[![Normativa DGI Oficial](https://img.shields.io/badge/DGI-Normativa%20Oficial%20Uruguay-orange?style=flat-square)](https://www.dgi.gub.uy/)
[![Normativa BPS Oficial](https://img.shields.io/badge/BPS-Normativa%20Oficial%20Uruguay-orange?style=flat-square)](https://www.bps.gub.uy/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%7C%20D1%20%7C%20Vectorize-F48120?style=flat-square&logo=cloudflare)](https://workers.cloudflare.com/)
[![Edge AI](https://img.shields.io/badge/Workers%20AI-Edge%20Inference-F48120?style=flat-square&logo=cloudflare)](https://developers.cloudflare.com/workers-ai/)

Plataforma full-stack de asesoramiento regulatorio tributario y de seguridad social uruguayo, construida sobre el edge de Cloudflare. Diseñada desde cero para cumplir con el **secreto tributario (Art. 47 Código Tributario)** y la **protección de datos personales (Ley 18.331 / URCDP)**, entregando respuestas grounded en normativa oficial con latencia de borde.

## ¿Qué hace Adviser?

Adviser es un asistente legal especializado en regulación uruguaya (DGI / BPS) que:

- **Responde preguntas sobre normativa** tributaria y de seguridad social con fuentes verificables del corpus legislativo oficial (T.O. DGI, Decretos, Instructivos BPS).
- **Protege automáticamente la privacidad**: anonimiza CIs, RUTs y montos antes de enviarlos al modelo mediante redacción PII integrada.
- **Garantiza respuestas fundamentadas**: cada respuesta se genera exclusivamente a partir de fragmentos del corpus ingresado — sin alucinaciones ni respuestas genéricas.
- **Gestiona acceso por organización**: autenticación sin contraseña (OTP por email), multi-tenant, con feature flags por organización.
- **Escala globalmente** gracias al edge de Cloudflare, con inferencia local sin latencia intercontinental.

## Cumplimiento legal Uruguay

| Requisito | Implementación |
|-----------|---------------|
| **Art. 47 Código Tributario** — Secreto tributario | Redacción automática de RUT, CI y montos antes de cualquier procesamiento por IA |
| **Ley 18.331 (URCDP)** — Datos personales | PII sanitizada en memoria; nunca persiste información identificable en logs ni vectores |
| **Grounding normativo** | Respuestas generadas exclusivamente desde documentos oficiales ingresados; cita obligatoria de fuente |
| **Acceso auditado** | Sesiones con TTL de 24 h, revocación server-side, logs de acceso por tenant |
| **Rate limiting** | 20 req/IP/60s en todas las APIs para prevenir abuso y cumplir obligaciones de servicio |

## Arquitectura

```
┌─────────────────────────────────────────────────────┐
│                  Cloudflare Edge                     │
│                                                      │
│  ┌──────────────┐    ┌─────────────────────────┐    │
│  │  Astro 7     │    │   Cloudflare Worker      │    │
│  │  Static Site │◄──►│   (TypeScript / Hono)    │    │
│  └──────────────┘    └────────┬────────────────┘    │
│                               │                      │
│              ┌────────────────┼──────────────────┐  │
│              ▼                ▼                   ▼  │
│         ┌────────┐     ┌──────────┐     ┌──────────┐│
│         │   D1   │     │Vectorize │     │Workers AI││
│         │(SQLite)│     │(semantic)│     │(LLM/emb) ││
│         └────────┘     └──────────┘     └──────────┘│
└─────────────────────────────────────────────────────┘
```

**Stack completo:**
- **Worker**: TypeScript + Hono — routing, auth, rate limiting, RAG pipeline
- **D1**: Esquema relacional + FTS5 — documentos, sesiones, tenants, feature flags
- **Vectorize**: Búsqueda semántica sobre embeddings (768 dim, cosine)
- **Workers AI**: Generación y embedding en el edge
- **Astro 7**: Frontend estático con páginas públicas y privadas
- **Resend**: Email transaccional para OTP

## Funcionalidades principales

| Feature | Descripción |
|---------|-------------|
| 🔒 **OTP Auth + Multi-tenant** | Login sin contraseña por email; primer login crea tenant automáticamente |
| 📚 **Contextual RAG** | Retrieval semántico (Vectorize) + léxico (FTS5) sobre corpus legislativo |
| 🛡️ **PII Sanitization** | Redacción de CI, RUT y montos antes de enviar al modelo |
| 🚦 **Feature Flags** | Flags por tenant con fallback global almacenados en D1 |
| ⚡ **Rate Limiting** | Workers Rate Limiting nativo — 20 req/IP/60s |
| 🌐 **Dual Environment** | Ambientes `production` y `develop` completamente aislados en Cloudflare |

## Instalación y despliegue

### 1. Instalar dependencias

```bash
npm install
```

### 2. Autenticarse en Cloudflare

```bash
npx wrangler login
```

### 3. Crear base D1

```bash
npx wrangler d1 create advisor_uy_db
```

Copiar el `database_id` retornado y reemplazar `REPLACE_WITH_D1_DATABASE_ID` en `wrangler.jsonc`.

### 4. Crear índice Vectorize

```bash
npx wrangler vectorize create advisor-uy-index --dimensions=768 --metric=cosine
```

### 5. Configurar secretos del Worker

```bash
npx wrangler secret put EMAIL_API_KEY   # Resend API key
npx wrangler secret put EMAIL_FROM      # Dirección de envío verificada en Resend
```

### 6. Aplicar migraciones y build

```bash
npm run db:migrate:local
npm run build
```

### 7. Deploy

```bash
npm run deploy
```

## Ambiente develop (aislado)

```bash
# Crear recursos para develop
npx wrangler d1 create advisor_uy_db_develop
npx wrangler vectorize create advisor-uy-index-develop --dimensions=768 --metric=cosine
npx wrangler secret put EMAIL_API_KEY --env develop
npx wrangler secret put EMAIL_FROM --env develop
```

Actualizar `database_id` del ambiente `develop` en `wrangler.jsonc`, luego:

```bash
npx wrangler deploy --env develop
```

## CI/CD — GitHub Actions

Agregar en **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

El workflow se activa automáticamente:
- **Push a `main`** → aplica migraciones + deploya en producción
- **Push a `develop`** → aplica migraciones + deploya en ambiente develop aislado

## Documentación de features

Ver carpeta [`features/`](./features/) para documentación detallada de cada funcionalidad:

- [`auth-otp.md`](./features/auth-otp.md) — Autenticación OTP y modelo de tenants
- [`contextual-rag.md`](./features/contextual-rag.md) — Pipeline de retrieval y generación
- [`pii-sanitization.md`](./features/pii-sanitization.md) — Redacción de datos sensibles
- [`hybrid-search.md`](./features/hybrid-search.md) — Búsqueda semántica + léxica
- [`feature-flags.md`](./features/feature-flags.md) — Gestión de flags por tenant
- [`rate-limiting.md`](./features/rate-limiting.md) — Configuración de rate limiting
- [`document-ingestion.md`](./features/document-ingestion.md) — API de ingestión de documentos
- [`ai-grounded-answers.md`](./features/ai-grounded-answers.md) — Generación grounded con IA
- [`public-private-web.md`](./features/public-private-web.md) — Arquitectura web pública/privada
