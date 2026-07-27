# Tech Spec: Public/Private Web Split

## Stack

Astro 7 (static output) + Worker Hono. No requiere bindings adicionales para el split en sí.

## Bindings requeridos (`wrangler.jsonc`)

| Binding | Tipo | Propósito |
|---------|------|-----------|
| `ASSETS` | Static Assets | Sirve el build estático de Astro desde `./dist` |
| `DB` | D1 | El Worker valida la sesión en las rutas `/api/*` |

## Estructura de archivos

```
web/
├── layouts/
│   ├── BaseLayout.astro     # Layout base (meta, CDN Tailwind)
│   └── AppLayout.astro      # Layout privado: auth guard + nav
├── pages/
│   ├── index.astro          # Landing pública
│   ├── verify.astro         # Pantalla de ingreso del OTP
│   └── app/                 # Páginas privadas (requieren sesión)
│       ├── index.astro
│       ├── impuestos.astro
│       ├── empresas.astro
│       ├── calendario.astro
│       └── ...
└── components/
    ├── NavBar.astro
    ├── Hero.astro
    ├── Features.astro
    └── Footer.astro
```

## Auth guard (cliente)

`AppLayout.astro` incluye un script inline que verifica `localStorage.getItem('adviser_session')`. Si no existe, redirige a `/?login=required`.

```javascript
// AppLayout.astro (script inline)
const session = localStorage.getItem('adviser_session')
if (!session) window.location.href = '/?login=required'
```

## Build pipeline

```
npm run build
  → astro build   (web/ → dist/)
  → tsc --noEmit  (type-check del Worker)
```

El Worker Hono recibe todas las requests. Rutas `/api/*` las maneja el Worker; el resto las sirve el binding `ASSETS` (Cloudflare Static Assets).

## Nuevas páginas por feature

Al agregar features, cada nueva sección del producto crea páginas en `web/pages/app/`. El `AppLayout.astro` provee automáticamente el guard de autenticación y el nav.

## Checklist de implementación técnica

- [x] Astro 7 configurado con `srcDir: ./web`, `outDir: ./dist`, `output: 'static'`
- [x] `web/layouts/BaseLayout.astro` y `web/layouts/AppLayout.astro` creados
- [x] `web/components/NavBar.astro`, `Hero.astro`, `Features.astro`, `Footer.astro` creados
- [x] Auth guard client-side en `AppLayout.astro` con `localStorage.getItem('adviser_session')`
- [x] Binding `ASSETS` en `wrangler.jsonc`
- [x] Pipeline `npm run build`: `astro build` + `tsc --noEmit`
