# Automatización de Portales DGI / BPS

## Descripción

Permite a Adviser interactuar con los portales gubernamentales **DGI SIGA** y **BPS SUNA** en nombre del usuario mediante un browser headless, eliminando la necesidad de ingresar manualmente a cada portal para consultar deudas, descargar constancias o verificar el estado de cuenta.

## Casos de uso

| Portal | Tarea | Descripción |
|--------|-------|-------------|
| DGI SIGA | Consulta estado de cuenta | Visualiza el estado de obligaciones tributarias del período actual |
| DGI SIGA | Descarga de constancia | Descarga la constancia de situación fiscal vigente |
| DGI SIGA | Consulta de deuda | Lista la deuda fiscal pendiente con DGI |
| BPS SUNA | Consulta estado de cuenta | Visualiza el estado de cuenta patronal |
| BPS SUNA | Descarga de constancia | Descarga la constancia de vigencia BPS |
| BPS SUNA | Consulta de deuda | Lista la deuda patronal pendiente con BPS |

## Flujo de usuario

1. **Conectar portal:** El usuario ingresa sus credenciales de DGI o BPS en Adviser. Adviser abre el portal en un browser headless, verifica que las credenciales sean válidas y guarda las cookies de sesión de forma cifrada.

2. **Ejecutar tarea:** El usuario selecciona una empresa y una tarea (ej: "consultar estado de cuenta"). Adviser reutiliza la sesión almacenada para navegar al portal sin pedir credenciales de nuevo.

3. **Sesión expirada:** Si las cookies expiraron, Adviser le avisa al usuario y le pide reconectar el portal con sus credenciales.

4. **Desconectar:** El usuario puede eliminar la sesión almacenada en cualquier momento desde la interfaz.

## Seguridad y privacidad

- Las cookies de sesión se cifran con **AES-256-GCM** antes de persistirse en la base de datos. La clave de cifrado es un Worker Secret que nunca se almacena en código ni en la BD.
- Las credenciales del usuario (usuario/contraseña) **nunca se almacenan**. Solo se guardan las cookies de sesión resultantes.
- La funcionalidad está protegida por el feature flag `portal_automation_enabled`, desactivado por defecto.
- El usuario debe dar consentimiento explícito al conectar el portal.

## Limitaciones conocidas

- **CAPTCHA:** Si DGI o BPS habilitan un CAPTCHA en el login, la automatización no puede completarse. Adviser informa esta situación al usuario.
- **Cambios en el portal:** Un rediseño del portal gubernamental puede romper los selectores CSS. Se recomienda monitorear activamente y tener alertas cuando los endpoints fallen.
- **IPs de Cloudflare:** Los portales gubernamentales podrían bloquear rangos de IP de datacenter. Si ocurre, se debe configurar un proxy residencial en la capa de Browser Rendering.
- **Sesiones cortas:** Las sesiones de DGI/BPS tienen una duración limitada; el usuario deberá reconectar periódicamente.

## Checklist de implementación

### Prerequisito
- [ ] Cloudflare Browser Rendering habilitado en el account
- [ ] Worker Secret `PORTAL_ENCRYPTION_KEY` (32 bytes hex, AES-256-GCM) configurado

### Base de datos
- [ ] Tabla `portal_sessions` creada con campos `portal`, `company_id`, `encrypted_cookies`, `expires_at`
- [ ] Índice `(tenant_id, company_id, portal)` creado

### Backend
- [ ] `POST /api/portal/dgi/connect` — valida credenciales DGI, guarda cookies cifradas
- [ ] `POST /api/portal/bps/connect` — valida credenciales BPS, guarda cookies cifradas
- [ ] `GET /api/portal/:portal/status` — verifica si la sesión almacenada sigue activa
- [ ] `DELETE /api/portal/:portal` — elimina sesión almacenada (desconectar)
- [ ] `POST /api/portal/dgi/tasks/:task` — ejecuta tarea DGI (estado_cuenta, constancia, consulta_deuda)
- [ ] `POST /api/portal/bps/tasks/:task` — ejecuta tarea BPS (estado_cuenta, constancia, consulta_deuda)
- [ ] Browser Rendering configurado con selectores CSS para SIGA DGI y SUNA BPS
- [ ] Cifrado AES-256-GCM de cookies antes de persistir en D1
- [ ] Credenciales del usuario NUNCA almacenadas — solo las cookies de sesión resultantes
- [ ] Feature flag `portal_automation_enabled` (desactivado por defecto) protegiendo todos los endpoints

### Frontend
- [ ] `/app/portales` — lista de portales conectados con estado de sesión por empresa
- [ ] `/app/portales/:portal/conectar` — formulario de credenciales con advertencia de seguridad
- [ ] Pantalla de consentimiento explícito antes de conectar (con texto legal visible)

### Validación
- [ ] Flujo DGI: consulta estado de cuenta retorna datos del período correcto
- [ ] Flujo BPS: descarga constancia de vigencia genera archivo PDF
- [ ] Sesión expirada informa al usuario y solicita reconexión (no guarda contraseña)
- [ ] Desconexión elimina cookies de D1 completamente
- [ ] CAPTCHA en portal gubernamental detectado y reportado al usuario
- [ ] Feature flag `portal_automation_enabled` desactivado en nuevos tenants por defecto
