# Feature: Public/Private Web Split (Separación Landing / Producto)

## Descripción

La aplicación web (construida con **Astro** en modo estático) se divide en dos secciones con acceso diferenciado:

- **Sección pública** (`/`): landing page informativa, accesible a cualquier visitante.
- **Sección privada** (`/app/*`): producto de asesoría real, protegida con un token de acceso almacenado en `localStorage`.

## Casos de uso

- **UC-021** Un visitante accede a `/` y ve la landing page con descripción del producto, funcionalidades y CTA para solicitar acceso.
- **UC-022** Un usuario con token válido accede a `/app` y visualiza el asistente de consultas regulatorias.
- **UC-023** Un usuario sin token intenta acceder a `/app` directamente — la página redirige a `/` con un parámetro `?login=required`.
- **UC-024** Un administrador con token accede a `/app/ingest` para cargar nuevos documentos normativos al corpus.
- **UC-025** El usuario puede cerrar sesión (logout) eliminando el token de `localStorage` desde el menú de la app.

## Estructura de rutas

### Rutas públicas
| Ruta | Descripción |
|------|-------------|
| `/` | Landing page: hero, features, CTA |

### Rutas privadas (requieren token)
| Ruta | Descripción |
|------|-------------|
| `/app` | Interfaz principal de consulta (búsqueda RAG) |
| `/app/ingest` | Panel de administración para ingestión de documentos |

## Mecanismo de autenticación (MVP)

La guardia de acceso es del lado del cliente (client-side guard):

1. En cada página privada, un script inline verifica `localStorage.getItem("advisor_uy_token")`.
2. Si el token no existe, redirige a `/?login=required`.
3. Si el token existe, la página carga normalmente.
4. El token se establece desde la landing page mediante un modal de acceso.

> **Nota:** Esta implementación es apropiada para un MVP. En producción se recomienda migrar a **Cloudflare Access** (Zero Trust) o un sistema de autenticación basado en JWT con Workers KV.

## Componentes Astro

| Componente | Ubicación | Propósito |
|------------|-----------|-----------|
| `BaseLayout.astro` | `web/layouts/` | Layout base con meta tags y CSS global |
| `AppLayout.astro` | `web/layouts/` | Layout para páginas privadas con nav y auth guard |
| `NavBar.astro` | `web/components/` | Barra de navegación (pública/privada) |
| `Hero.astro` | `web/components/` | Sección hero de landing |
| `Features.astro` | `web/components/` | Tarjetas de funcionalidades |
| `Footer.astro` | `web/components/` | Pie de página |

## Build pipeline

```
Astro build (srcDir: ./web, outDir: ./dist)
  → dist/ (HTML/CSS/JS estático)
    → montado en Workers Static Assets (binding ASSETS)
      → fallback desde Worker Hono (para rutas /api/*)
```

## Mejoras futuras (v2)

- Integrar Cloudflare Access para autenticación Zero Trust sin código custom.
- Agregar roles: `viewer` (solo consultas) vs `admin` (consultas + ingestión).
- Implementar registro de usuarios con D1 y sesiones firmadas (JWT en Workers KV).
- Agregar `/app/history` para historial de consultas por usuario.

## Checklist de implementación

### Infraestructura
- [x] Astro 7 configurado con `srcDir: ./web`, `outDir: ./dist`, `output: 'static'`
- [x] Binding `ASSETS` en `wrangler.jsonc` para servir el sitio estático desde el Worker
- [x] Fallback a Hono para rutas `/api/*` desde el Worker

### Componentes Frontend
- [x] `BaseLayout.astro` — layout base con meta tags y CSS global
- [x] `AppLayout.astro` — layout para páginas privadas con auth guard client-side
- [x] `NavBar.astro` — barra de navegación diferenciada pública/privada
- [x] `Hero.astro`, `Features.astro`, `Footer.astro` — componentes de landing

### Páginas
- [x] `/` — landing page pública con hero, features, CTA de acceso
- [x] `/login` — formulario de email para solicitar OTP
- [x] `/verify` — validación de OTP y redirección a `/app`
- [x] `/app` — interfaz principal de consulta (auth guard activo)
- [x] `/app/ingest` — panel de administración para ingestión (auth guard activo)

### Seguridad
- [x] Auth guard client-side: redirige a `/?login=required` si no hay token en `localStorage`
- [x] Token almacenado en `localStorage` con clave `adviser_session`

### Validación
- [x] UC-021: visitante sin token ve la landing normalmente
- [x] UC-022: usuario con token accede a `/app` correctamente
- [x] UC-023: acceso directo a `/app` sin token redirige a `/?login=required`
- [x] UC-025: logout elimina token de `localStorage` y redirige a landing

### Pendiente (v2)
- [ ] Migrar auth guard a Cloudflare Access (Zero Trust) para SSO y hardware-key
- [ ] Roles en frontend: `viewer` vs `admin`
- [ ] `/app/history` — historial de consultas por usuario
