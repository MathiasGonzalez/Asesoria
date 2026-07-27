# Feature: Portal del Cliente (Client Collaboration Portal)

## Descripción

Portal seguro que permite a estudios contables colaborar con sus clientes: solicitar documentos pendientes, compartir informes finalizados, gestionar aprobaciones y mantener una comunicación centralizada — todo sin usar email ni WhatsApp. Cada cliente del estudio tiene su propio espacio con acceso limitado a su información.

## Casuística de mercado

La relación estudio contable → cliente es uno de los mayores cuellos de botella de la industria:

- Los contadores pasan 30–40% de su tiempo persiguiendo documentos que los clientes no enviaron a tiempo.
- Los clientes olvidan qué documentos mandaron y cuáles faltan; sin visibilidad del estado.
- El intercambio por WhatsApp/email mezcla conversaciones personales con información fiscal sensible.
- Las aprobaciones de balances y declaraciones se hacen informalmente sin registro ni firma digital.
- Los estudios grandes pierden horas coordinando qué cliente está al día y cuál tiene pendientes.

## Casos de uso

- **UC-090** Un contador crea una "solicitud de documentos" para su cliente en marzo: pide el resumen bancario, la planilla de sueldos y las facturas del mes. El cliente recibe una notificación y sube los archivos directamente desde su teléfono.
- **UC-091** El cliente ve en su portal qué documentos fueron recibidos y validados por el estudio, y cuáles siguen pendientes — con fecha límite de entrega.
- **UC-092** El estudio finaliza el análisis del período y comparte el informe consolidado con el cliente vía el portal. El cliente lo descarga con un enlace firmado (token de tiempo limitado).
- **UC-093** El cliente aprueba digitalmente un balance anual desde el portal. La aprobación queda registrada con timestamp e IP para auditoría.
- **UC-094** Un contador ve el dashboard de todos sus clientes: quiénes tienen documentos pendientes, quiénes aprobaron su informe y quiénes tienen vencimientos próximos.

## Roles

| Rol | Acceso |
|-----|--------|
| `accountant` | Ve todos los clientes del tenant, crea solicitudes, sube informes, ve analytics |
| `client` | Ve solo su empresa, sube documentos solicitados, descarga informes propios, aprueba |
| `admin` | Acceso total al tenant — configura usuarios y permisos |

## Modelo de datos

```sql
client_invitations (
  id, tenant_id, company_id,
  email          TEXT,
  token          TEXT,    -- token de invitación (expira en 7 días)
  status         TEXT,    -- pending | accepted | expired
  invited_by     TEXT,    -- user_id del contador
  created_at
)

document_requests (
  id, tenant_id, company_id, created_by,
  title          TEXT,    -- "Documentos Marzo 2025"
  description    TEXT,
  due_date       DATE,
  status         TEXT,    -- open | partial | complete | cancelled
  created_at
)

document_request_items (
  id, request_id,
  label          TEXT,    -- "Resumen bancario BROU"
  doc_type       TEXT,    -- tipo de documento esperado
  required       INTEGER DEFAULT 1,
  fulfilled      INTEGER DEFAULT 0,
  document_id    TEXT,    -- FK a tax_documents cuando se sube
  fulfilled_at   TIMESTAMP
)

client_approvals (
  id, tenant_id, company_id, period_id,
  approved_by    TEXT,    -- user_id del cliente
  approved_at    TIMESTAMP,
  ip_address     TEXT,
  document_hash  TEXT,    -- hash del informe aprobado para no-repudio
  notes          TEXT
)
```

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST`   | `/api/portal/invite` | Invita a un cliente por email |
| `POST`   | `/api/portal/accept-invite` | Cliente acepta invitación y crea su cuenta |
| `GET`    | `/api/portal/clients` | Lista clientes del tenant (vista contador) |
| `GET`    | `/api/portal/clients/:companyId/status` | Estado de pendientes del cliente |
| `POST`   | `/api/portal/requests` | Crea solicitud de documentos |
| `GET`    | `/api/portal/requests` | Lista solicitudes (filtrable por empresa/estado) |
| `PUT`    | `/api/portal/requests/:id` | Actualiza solicitud |
| `POST`   | `/api/portal/requests/:id/fulfill/:itemId` | Cliente sube documento que satisface un ítem |
| `POST`   | `/api/portal/approvals` | Cliente aprueba un informe |
| `GET`    | `/api/portal/approvals/:periodId` | Consulta estado de aprobación de un período |
| `GET`    | `/api/portal/share/:token` | Descarga informe compartido (link temporal) |

## Dashboard del contador

La vista `/app/portal/dashboard` muestra:

- **Semáforo de clientes**: 🔴 con pendientes vencidos / 🟠 pendientes próximos / 🟢 al día.
- **Cola de documentos recibidos**: archivos subidos por clientes que esperan revisión.
- **Aprobaciones pendientes**: informes enviados pero aún no aprobados por el cliente.
- **Vencimientos próximos**: por empresa, integrado con el Calendario Fiscal.

## Páginas

- `/app/portal/dashboard` — Vista general de todos los clientes (rol contador)
- `/app/portal/clientes/:id` — Vista detallada de un cliente específico
- `/app/portal/solicitudes` — Gestión de solicitudes de documentos
- `/app/cliente` — Portal del cliente (acceso cliente: mis pendientes, mis informes)

## Seguridad

- Los clientes solo pueden ver su propia empresa (aislamiento por `company_id`).
- Los links de descarga de informes son tokens firmados con TTL de 72 horas.
- Las aprobaciones digitales se almacenan con hash SHA-256 del documento aprobado.
- Los contadores no pueden ver el portal de otra empresa de otro tenant.

## Mejoras futuras (v2)

- Chat integrado dentro de cada solicitud (reemplaza WhatsApp)
- Firma digital con e.Firma o firma electrónica avanzada (Ley 18.600)
- App móvil para clientes (subir foto de factura directamente desde el teléfono)
- Recordatorios automáticos: email/WhatsApp a clientes con pendientes D-3 al vencimiento
- Métricas del estudio: tiempo promedio de procesamiento por cliente

## Checklist de implementación

### Prerequisito
- [ ] `multi-user-teams.md` implementado (roles `client`, `accountant`, `admin`)

### Base de datos
- [ ] Tabla `client_invitations` creada
- [ ] Tabla `document_requests` creada
- [ ] Tabla `document_request_items` creada
- [ ] Tabla `client_approvals` creada con campo `document_hash` para no-repudio

### Backend
- [ ] `POST /api/portal/invite` — invita cliente por email, crea `client_invitations`
- [ ] `POST /api/portal/accept-invite` — cliente acepta invitación, crea cuenta con rol `client`
- [ ] `GET /api/portal/clients` — lista clientes del tenant (vista contador)
- [ ] `GET /api/portal/clients/:companyId/status` — estado de pendientes del cliente
- [ ] `POST /api/portal/requests` — crea solicitud de documentos
- [ ] `GET /api/portal/requests` — lista solicitudes con filtros por empresa/estado
- [ ] `PUT /api/portal/requests/:id` — actualiza solicitud
- [ ] `POST /api/portal/requests/:id/fulfill/:itemId` — cliente sube documento para un ítem
- [ ] `POST /api/portal/approvals` — cliente aprueba informe (guarda hash + timestamp + IP)
- [ ] `GET /api/portal/approvals/:periodId` — consulta estado de aprobación
- [ ] `GET /api/portal/share/:token` — descarga informe compartido (link temporal con TTL)

### Frontend
- [ ] `/app/portal/dashboard` — semáforo de clientes (🔴🟠🟢), cola de docs recibidos, aprobaciones pendientes
- [ ] `/app/portal/clientes/:companyId` — vista del cliente con solicitudes y documentos
- [ ] `/portal/:token` — portal público del cliente (sin nav de la app)

### Validación
- [ ] UC-090: cliente recibe notificación y sube archivos correctamente
- [ ] UC-091: cliente ve documentos recibidos y pendientes con fecha límite
- [ ] UC-092: link de descarga firmado con TTL funciona y expira
- [ ] UC-093: aprobación digital registra timestamp, IP y hash del documento
- [ ] UC-094: contador ve dashboard con semáforo de todos sus clientes
