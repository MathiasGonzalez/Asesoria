# Feature: Document Ingestion (Ingestión de Documentos Normativos)

## Descripción

Pipeline de incorporación de documentos legales uruguayos (T.O. DGI, Decretos, Instructivos BPS, Circulares) al corpus de conocimiento de la plataforma. Cada documento se fracciona, contextualiza con IA y vectoriza para habilitarlo en la búsqueda híbrida.

## Casos de uso

- **UC-013** Un administrador sube el Texto Ordenado 1996 de DGI en partes. El sistema fracciona el texto, genera contexto para cada chunk y lo indexa.
- **UC-014** Se incorpora un nuevo Decreto que modifica el IRPF. El sistema lo ingesta con `source: "DGI"` y la URL oficial del Diario Oficial.
- **UC-015** Se ingest un Instructivo de BPS sobre aportes patronales. Los fragmentos quedan disponibles en búsquedas relacionadas a BPS.
- **UC-016** Cada chunk queda vinculado al documento padre mediante `document_id`, permitiendo trazabilidad completa hasta la fuente.

## API endpoint

```
POST /api/ingest
Content-Type: application/json

{
  "id": "to-dgi-96-titulo1",
  "title": "T.O. DGI 1996 - Título 1: IRAE",
  "source": "DGI",
  "content": "El Impuesto a las Rentas de las Actividades Económicas...",
  "url": "https://www.dgi.gub.uy/wdgi/hgxpp001?6,1,..."
}
```

### Respuesta exitosa
```json
{
  "success": true,
  "message": "Document 'T.O. DGI 1996 - Título 1: IRAE' ingested and contextualized successfully."
}
```

## Campos requeridos

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | string | Identificador único del documento (snake_case) |
| `title` | string | Título descriptivo del documento |
| `source` | string | Origen: `"DGI"` o `"BPS"` |
| `content` | string | Texto completo del documento |
| `url` | string? | URL de la fuente oficial (opcional pero recomendado) |

## Parámetros de chunking

- **Ventana:** 500 caracteres por chunk
- **ID de chunk:** `{document_id}_chunk_{index}`
- **Contexto AI:** cada chunk recibe un resumen de 1-2 oraciones explicando su posición en el documento

## Mejoras futuras (v2)

- Chunking semántico (por párrafo o sección legal) en lugar de ventana fija
- Soporte para PDF directo con OCR via Workers AI
- Gestión de versiones: actualizar documentos sin duplicar chunks
- Endpoint `DELETE /api/ingest/:id` para retirar documentos desactualizados
- Interfaz web de administración en `/app/ingest` para carga masiva

## Checklist de implementación

### Base de datos
- [x] Tabla `documents` creada con campos `id`, `title`, `source`, `url`
- [x] Tabla `document_chunks` creada con campos `chunk_id`, `document_id`, `text`, `context`
- [x] Tabla FTS5 `document_chunks_fts` con triggers de sincronización automática

### Backend
- [x] `POST /api/ingest` — acepta `{ id, title, source, content, url? }`
- [x] Chunking por ventanas de 500 chars con ID `{document_id}_chunk_{index}`
- [x] Contextualización AI por chunk (llama-3-8b-instruct)
- [x] Upsert de vectores en Vectorize con metadatos `document_id`, `source`
- [x] Guardado de chunks en D1 con texto + contexto

### Validación
- [x] UC-013: ingestión de T.O. DGI fraccionado y contextualizado correctamente
- [x] UC-014: ingestión de decreto con `source: "DGI"` y URL oficial
- [x] UC-015: ingestión de instructivo BPS disponible en búsquedas relacionadas
- [x] UC-016: trazabilidad de chunk → documento padre verificada
- [x] Ingestión de documento duplicado (mismo `id`) no genera chunks dobles

### Pendiente (v2)
- [ ] Chunking semántico por párrafo o sección legal
- [ ] Soporte para PDF directo con OCR via Workers AI
- [ ] Gestión de versiones: actualizar documentos sin duplicar chunks
- [ ] `DELETE /api/ingest/:id` para retirar documentos desactualizados
- [ ] Interfaz web de administración en `/app/ingest` para carga masiva
