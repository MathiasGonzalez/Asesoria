# Feature: Company Profiles (Perfiles de Empresa)

## Descripción

Gestión de fichas de empresas/contribuyentes vinculadas a los análisis impositivos. Permite registrar los datos fiscales clave de cada empresa (RUT, razón social, tipo de entidad, régimen tributario) para contextualizar automáticamente el análisis de IA con la información correcta.

## Casos de uso

- **UC-050** Un estudio contable crea el perfil de su cliente "Empresa ABC SRL" con RUT, régimen IRAE Real y N° patronal BPS. Al crear períodos para esa empresa, el prompt de IA incluye automáticamente el régimen correcto.
- **UC-051** Un usuario edita el régimen de una empresa de "Forfait" a "Real" cuando supera el límite de facturación anual.
- **UC-052** Al eliminar una empresa, se pide confirmación. Los períodos históricos vinculados conservan su historial (la FK company_id queda como null si la empresa se elimina).
- **UC-053** El RUT se normaliza (se eliminan puntos, guiones y espacios) y se valida que tenga exactamente 12 dígitos.

## Modelo de datos

```sql
companies (
  id, user_id, tenant_id,
  rut              TEXT UNIQUE(user_id, rut),
  razon_social     TEXT,
  nombre_comercial TEXT,
  tipo_entidad     TEXT,   -- srl | sa | unipersonal | cooperativa | ong | sas | otro
  regimen_irae     TEXT,   -- real | forfait | pequena_empresa | monotributo | exonerado | irnr
  actividad        TEXT,
  bps_nro_patronal TEXT,
  domicilio_fiscal TEXT,
  created_at, updated_at
)
```

## API endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`    | `/api/companies` | Lista empresas del usuario autenticado |
| `POST`   | `/api/companies` | Crea empresa (requiere `rut`, `razon_social`) |
| `PUT`    | `/api/companies/:id` | Actualiza empresa (excepto RUT) |
| `DELETE` | `/api/companies/:id` | Elimina empresa |

### Validación de RUT

- Se eliminan puntos, guiones y espacios automáticamente.
- El RUT resultante debe tener **exactamente 12 dígitos**.
- Ejemplo válido: `210000010018` o con formato `21-000001-0018`.

## Integración con análisis impositivo

Cuando un período tiene `company_id` vinculado, el prompt de consolidación IA incluye:

```
EMPRESA ANALIZADA:
  Razón social: ABC SRL — RUT: 210000010018
  Tipo de entidad: Sociedad de Responsabilidad Limitada (SRL)
  Régimen tributario: IRAE — Método Real
  Actividad económica: Comercio al por menor
  N° Patronal BPS: 12345678
```

## Páginas

- `/app/empresas` — lista de empresas del usuario con modal de creación/edición

## Mejoras futuras

- Validación de dígito verificador del RUT (algoritmo DGI)
- Búsqueda de empresa por RUT en catálogo público de DGI
- Importación masiva desde CSV
- Compartir empresa entre usuarios del mismo tenant
