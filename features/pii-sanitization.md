# Feature: PII Sanitization (Anonimización de Datos Personales)

## Descripción

Redacción automática de datos personales sensibles antes de que cualquier texto llegue a los modelos de inteligencia artificial, garantizando el cumplimiento del **Artículo 47 del Código Tributario** (secreto tributario), el **Código de Ética del CCEAU** y la **Ley 18.331 URCDP** (protección de datos personales en Uruguay).

## Casos de uso

- **UC-001** Un contador redacta una consulta que incluye el RUT de su cliente (p.e. `212345678912`). El sistema lo reemplaza por `[RUT_REDACTADO]` antes de enviarlo al modelo.
- **UC-002** Una consulta menciona la cédula de identidad de un contribuyente (p.e. `3.456.789-0`). El sistema la sustituye por `[CI_REDACTADA]`.
- **UC-003** Una consulta incluye un monto exacto en pesos uruguayos (p.e. `$U 1.500.000`). El sistema lo reemplaza por `[MONTO_REDACTADO]`.
- **UC-004** Se sanitiza la consulta *antes* de cualquier logging o almacenamiento intermedio, garantizando trazabilidad sin exposición de PII.

## Implementación

- **Archivo:** `src/services/anonymizer.ts`
- **Clase:** `Anonymizer.sanitize(text: string): string`
- **Patrones regex:**
  - CI uruguaya: `\b\d{1,2}[.-]?\d{3}[.-]?\d{3}[.-]?\s?\d?\b`
  - RUT (12 dígitos, comienza en 12 o 21): `\b(12|21)\d{10}\b`
  - Montos en UYU/USD: `(\$U|\$|USD)\s?(\d{1,3}(\.\d{3})*(,\d+)?)`

## Integración en el flujo

```
Usuario → query → Anonymizer.sanitize() → RagService.searchNormative() → Workers AI
```

El campo `sanitizedQuery` se devuelve en la respuesta JSON junto con `originalQuery` para que el frontend pueda alertar al usuario cuando su consulta fue modificada.

## Limitaciones conocidas (v1)

- Solo cubre CI, RUT y montos monetarios. Nombres propios aún no se redactan.
- Los patrones regex no cubren formatos internacionales (pasaportes, NIF extranjeros).
- Mejora futura: aplicar Named Entity Recognition (NER) con un modelo local para entidades no estructuradas.

## Checklist de implementación

### Backend
- [x] `src/services/anonymizer.ts` con clase `Anonymizer` implementada
- [x] Regex para CI uruguaya (formatos con y sin puntos/guiones)
- [x] Regex para RUT de 12 dígitos (comienza en 12 o 21)
- [x] Regex para montos en UYU/USD (con separadores de miles)
- [x] `Anonymizer.sanitize()` aplicado antes de todo logging y envío a Workers AI
- [x] Campo `sanitizedQuery` devuelto en la respuesta para alertar al usuario

### Validación
- [x] UC-001: RUT redactado como `[RUT_REDACTADO]`
- [x] UC-002: CI redactada como `[CI_REDACTADA]`
- [x] UC-003: montos redactados como `[MONTO_REDACTADO]`
- [x] UC-004: sanitización ocurre antes del logging y del envío a IA
- [x] Texto sin PII pasa sin modificaciones (no hay falsos positivos en texto normal)
