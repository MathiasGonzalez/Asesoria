# Fase 3 — Agentes IA Especializados

## Objetivo

Evolucionar el asistente genérico de normativa hacia **agentes dominio-específicos** que actúen sobre datos reales del tenant: documentos del período, extractos bancarios, liquidaciones de sueldo, CFEs emitidos. Cada agente tiene un contexto acotado, herramientas propias y flujos de revisión humana antes de tomar acciones.

**Principio de diseño:** Los agentes en contabilidad/legal **no actúan de forma autónoma irreversible**. Toda acción de consecuencia (cerrar período, generar declaración, aprobar liquidación) pasa por revisión explícita del contador.

---

## Arquitectura: Orquestador + Agentes Especializados

```
Usuario → Orquestador (intent detection) → Agente especializado
                                                ↓
                                     Herramientas (tools)
                                     [D1 queries, R2 reads,
                                      Workers AI, CFE API, etc.]
                                                ↓
                                     Respuesta + acciones propuestas
                                                ↓
                                     Revisar → Aprobar → Ejecutar
```

### Agentes disponibles

| Agente | Dominio | Descripción |
|--------|---------|-------------|
| **Agente Tributario** | IVA, IRAE, IRPF | Análisis de documentos del período, detección de inconsistencias, proyección de impuestos |
| **Agente Payroll** | Sueldos y RRHH | Cálculo de liquidaciones, interpretación de normas BPS/DGI Cat.1 |
| **Agente de Conciliación** | Bancos | Categorización de transacciones, cruce contra CFEs, detección de diferencias |
| **Agente de Compliance** | Legal/Normativa | Consultas sobre DGI/BPS, vencimientos, derechos y obligaciones |
| **Agente de Documentos** | Extracción y resumen | Clasificación automática, extracción de datos de facturas/extractos |

---

## Paso 3.1 — Agente Tributario

### Capacidades

1. **Análisis de período**: dado un `period_id`, lee todos los documentos asociados, calcula IVA Compras/Ventas, identifica discrepancias y genera un borrador del análisis.
2. **Proyección**: basado en el historial de períodos anteriores, estima la carga impositiva del mes actual.
3. **Detección de anomalías**: identifica documentos que no deberían estar en el período, facturas duplicadas, montos inusuales.
4. **Generación de consultas DGI/BPS**: formula preguntas sobre casos específicos del período y las responde con el corpus RAG.

### Herramientas del agente (tools en Workers AI / función calling)

```typescript
const taxAgentTools = [
  {
    name: 'get_period_documents',
    description: 'Obtiene los documentos y su contenido extraído del período fiscal',
    parameters: { period_id: 'string' }
  },
  {
    name: 'get_cfe_summary',
    description: 'Obtiene el resumen de CFEs emitidos y recibidos del mes',
    parameters: { company_id: 'string', month: 'number', year: 'number' }
  },
  {
    name: 'query_normativa',
    description: 'Busca en el corpus normativo DGI/BPS',
    parameters: { query: 'string' }
  },
  {
    name: 'get_previous_periods',
    description: 'Obtiene datos de períodos anteriores para comparativa',
    parameters: { company_id: 'string', months_back: 'number' }
  }
]
```

### Implementación con Durable Objects para estado

Cada sesión de agente es un Durable Object con estado:

```typescript
// src/agents/TaxAgent.ts
export class TaxAgentDO implements DurableObject {
  state: DurableObjectState
  messages: { role: string; content: string }[] = []
  tools: Tool[]
  companyId: string
  periodId: string

  async fetch(request: Request): Promise<Response> {
    const { message } = await request.json()

    this.messages.push({ role: 'user', content: message })

    const response = await this.runAgentLoop()

    return Response.json({ reply: response, actions: this.pendingActions })
  }

  async runAgentLoop() {
    // Bucle con function calling: genera respuesta → si hay tool call → ejecuta → continúa
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: TAX_AGENT_SYSTEM_PROMPT },
        ...this.messages
      ],
      tools: this.tools
    })

    if (result.tool_calls) {
      for (const call of result.tool_calls) {
        const toolResult = await this.executeTool(call.name, call.arguments)
        this.messages.push({ role: 'tool', content: JSON.stringify(toolResult) })
      }
      return this.runAgentLoop()  // recursivo hasta que no haya más tool calls
    }

    return result.response
  }
}
```

### System prompt del Agente Tributario

```
Sos un contador público uruguayo especializado en impuestos de DGI y seguridad social BPS.
Tenés acceso a los documentos del período fiscal de la empresa {razonSocial} (RUT: {rut}),
régimen tributario: {regimen}.

Reglas:
1. Toda afirmación sobre normativa debe citar el artículo o decreto específico.
2. Cuando detectes una inconsistencia, explicá el problema y sugerí la corrección — no la ejecutes.
3. Los montos sensibles ya fueron sanitizados (reemplazados por [MONTO]). Si necesitás calcular,
   pedile al usuario que confirme los valores.
4. Nunca sugieras eludir obligaciones fiscales. Si la pregunta apunta a eso, explicá el riesgo legal.
5. Si no sabés con certeza, decí "necesito consultar la normativa vigente" y usá query_normativa.
```

---

## Paso 3.2 — Agente Payroll

### Capacidades

1. **Cálculo asistido**: dado el salario nominal y complementos, calcula IRPF Cat.1, BPS personal/patronal, FONASA, FRL.
2. **Interpretación de normas**: responde preguntas sobre qué deducciones aplican, cómo liquidar horas extra, qué pasa con empleados con múltiples empleos.
3. **Verificación de escala BPC**: detecta automáticamente si la escala BPC vigente cambió y alerta si los cálculos usaban la escala anterior.
4. **Revisión de liquidaciones**: antes de cerrar el período de sueldos, el agente revisa todas las liquidaciones e identifica outliers (empleado con líquido muy diferente al mes anterior, tasa IRPF cambiada inesperadamente).

### Herramientas

```typescript
const payrollAgentTools = [
  {
    name: 'get_bpc_vigente',
    description: 'Obtiene el valor del BPC vigente para el cálculo IRPF',
    parameters: {}
  },
  {
    name: 'calculate_irpf_cat1',
    description: 'Calcula el IRPF Cat.1 dado el ingreso anual proyectado',
    parameters: { ingreso_nominal: 'number', complementos: 'number' }
  },
  {
    name: 'get_payroll_history',
    description: 'Obtiene historial de liquidaciones del empleado',
    parameters: { employee_id: 'string', months_back: 'number' }
  },
  {
    name: 'query_normativa',
    description: 'Consulta normativa BPS/DGI',
    parameters: { query: 'string' }
  }
]
```

---

## Paso 3.3 — Agente de Conciliación Bancaria

### Capacidades

1. **Categorización en lote**: procesa un extracto bancario completo y categoriza todas las transacciones con Workers AI.
2. **Matching con CFEs**: cruza transacciones contra CFEs emitidos/recibidos del mes buscando coincidencias por monto, fecha ±3 días y RUT del pagador.
3. **Detección de diferencias**: identifica transacciones no contabilizadas, débitos automáticos no previstos, duplicados.
4. **Aprendizaje por feedback**: cuando el contador corrige una categorización, el agente recuerda el patrón para futuras importaciones del mismo cliente.

### Memoria de patrones (Cloudflare KV)

```typescript
// Guarda patrones de categorización aprendidos por tenant+company
const patternKey = `bank_patterns:${tenantId}:${companyId}`
const patterns = await env.KV.get(patternKey, 'json') ?? []

// Cuando el contador corrige: { descripcion_match: 'ANTEL*', categoria: 'servicio' }
patterns.push({ pattern: normalizedDescription, categoria: correctedCategory })
await env.KV.put(patternKey, JSON.stringify(patterns))
```

---

## Paso 3.4 — Agente de Compliance

### Capacidades

1. **Consultas sobre normativa**: versión potenciada del RAG actual, con historial de conversación por sesión.
2. **Due diligence de proveedores**: dado un RUT, consulta si el proveedor tiene certificado DGI vigente.
3. **Alertas de vencimientos próximos**: proactivo — cuando faltan 5 días para un vencimiento, el agente envía un resumen de qué hay que presentar.
4. **Gestión de impugnaciones**: asiste en la redacción de recursos ante DGI/BPS, citando la normativa aplicable.

---

## Paso 3.5 — Agente de Documentos

### Capacidades

1. **Clasificación automática**: al subir un documento, el agente detecta el tipo (`planilla_sueldos`, `extracto_bancario`, `factura_proveedor`, etc.) y lo etiqueta automáticamente.
2. **Extracción de datos estructurados**: de una factura PDF extrae RUT, monto, IVA, fecha; de una planilla de sueldos extrae total de haberes, total de deducciones.
3. **Detección de documentos faltantes**: dado el historial del cliente, alerta si falta el extracto bancario del mes, la declaración jurada de IRPF, etc.

### Implementación de clasificación con Workers AI

```typescript
// src/services/document-classifier.ts
const classificationPrompt = `
Sos un asistente de clasificación de documentos contables uruguayos.
Dado el texto extraído de un documento, indicá:
1. Tipo de documento (una de estas categorías exactas):
   extracto_bancario | planilla_sueldos | factura_proveedor | nota_credito |
   boleta_bps | declaracion_dgi | balance | estado_resultados | otro
2. Período (mes/año si es posible, sino null)
3. Entidad emisora (nombre o RUT si está disponible)

Respondé SOLO en JSON: { "tipo": "...", "periodo": "MM/YYYY|null", "emisor": "...|null" }

Texto del documento:
{text}
`

const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
  messages: [{ role: 'user', content: classificationPrompt.replace('{text}', docText.slice(0, 2000)) }],
  max_tokens: 100
})
```

---

## Paso 3.6 — Orquestador (intent detection)

El orquestador recibe el mensaje del usuario y determina qué agente debe manejar el request:

```typescript
// src/agents/orchestrator.ts
const AGENT_ROUTING_PROMPT = `
Dado el siguiente mensaje de usuario en contexto de una app contable uruguaya,
determiná cuál agente debe responder. Respondé SOLO con una de estas palabras:
tax | payroll | bank | compliance | documents | general

Mensaje: "{message}"
`

async function routeToAgent(message: string, ctx: AppContext): Promise<string> {
  const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [{ role: 'user', content: AGENT_ROUTING_PROMPT.replace('{message}', message) }],
    max_tokens: 20
  })
  return result.response.trim().toLowerCase()
}
```

---

## Paso 3.7 — Guardrails y revisión humana

### Principios

| Acción | Tipo | Requiere aprobación |
|--------|------|---------------------|
| Responder una pregunta normativa | Informativa | No |
| Mostrar análisis del período | Informativa | No |
| Proponer categorización de transacción | Propuesta | Sí (contador corrige o aprueba) |
| Cerrar un período fiscal | Irreversible | Sí (rol `senior` mínimo) |
| Emitir un CFE | Irreversible | Sí (confirmar antes de enviar a DGI) |
| Generar archivo SUNA para BPS | Irreversible | Sí (revisión antes de subir) |
| Eliminar documentos | Irreversible | Sí (solo `admin`/`owner`) |

Los agentes **nunca ejecutan acciones irreversibles directamente**. Devuelven un objeto `action_proposal` que el frontend muestra para confirmación explícita.

```typescript
type AgentResponse = {
  message: string               // Texto para el usuario
  citations: Citation[]         // Fuentes normativas citadas
  action_proposal?: {           // Si el agente propone una acción
    type: 'categorize' | 'close_period' | 'emit_cfe' | 'generate_suna' | ...
    description: string         // Descripción legible para el usuario
    payload: Record<string, unknown>
    requires_role: 'accountant' | 'senior' | 'admin'
  }
}
```

---

## Entregables de la Fase 3

| Entregable | Descripción |
|------------|-------------|
| `src/agents/TaxAgent.ts` | Agente tributario con DO |
| `src/agents/PayrollAgent.ts` | Agente payroll con DO |
| `src/agents/BankAgent.ts` | Agente conciliación con DO |
| `src/agents/ComplianceAgent.ts` | Agente compliance (RAG avanzado) |
| `src/agents/DocumentAgent.ts` | Clasificador y extractor de documentos |
| `src/agents/Orchestrator.ts` | Intent detection y routing |
| `src/agents/types.ts` | `AgentResponse`, `ActionProposal`, `Tool` types |
| `wrangler.jsonc` | Bindings DO para cada agente, Queues, KV |
| `web/pages/app/asistente.astro` | UI de chat con el orquestador |

---

## Checklist de implementación

### Prerequisito
- [ ] Fase 1 (hardening) completada — tenant isolation y audit log en producción
- [ ] Workers AI con soporte de function calling / tool use habilitado en el account

### Paso 3.1 — Agente Tributario
- [ ] `src/agents/TaxAgent.ts` implementado como Durable Object con bucle de tool use
- [ ] Tools implementadas: `get_period_documents`, `get_cfe_summary`, `query_normativa`, `get_previous_periods`
- [ ] System prompt del Agente Tributario con guardrails de citas y no-elusión
- [ ] Binding DO `TAX_AGENT` en `wrangler.jsonc`

### Paso 3.2 — Agente Payroll
- [ ] `src/agents/PayrollAgent.ts` implementado como Durable Object
- [ ] Tools implementadas: `get_bpc_vigente`, `calculate_irpf_cat1`, `get_payroll_history`, `query_normativa`
- [ ] Binding DO `PAYROLL_AGENT` en `wrangler.jsonc`

### Paso 3.3 — Agente de Conciliación Bancaria
- [ ] `src/agents/BankAgent.ts` implementado
- [ ] Categorización en lote de extracto completo con Workers AI
- [ ] Matching CFEs-transacciones implementado con algoritmo monto ±1% + fecha ±5 días
- [ ] Memoria de patrones aprendidos en Cloudflare KV: `bank_patterns:{tenantId}:{companyId}`
- [ ] Binding `KV_BANK_PATTERNS` en `wrangler.jsonc`

### Paso 3.4 — Agente de Compliance
- [ ] `src/agents/ComplianceAgent.ts` implementado con historial de conversación por sesión
- [ ] Due diligence de proveedor por RUT (consulta DGI) implementado
- [ ] Alertas proactivas de vencimientos próximos (D-5) desde el agente

### Paso 3.5 — Agente de Documentos
- [ ] `src/agents/DocumentAgent.ts` con clasificación automática de tipo de documento
- [ ] `src/services/document-classifier.ts` usando `@cf/meta/llama-3.1-8b-instruct`
- [ ] Extracción de campos estructurados de facturas (RUT, monto, IVA, fecha)
- [ ] Detección de documentos faltantes según historial del cliente

### Paso 3.6 — Orquestador
- [ ] `src/agents/Orchestrator.ts` con intent detection por LLM
- [ ] Routing correcto a: `tax | payroll | bank | compliance | documents | general`
- [ ] `src/agents/types.ts` con tipos `AgentResponse`, `ActionProposal`, `Tool`

### Paso 3.7 — Guardrails y revisión humana
- [ ] Ningún agente ejecuta acciones irreversibles sin devolver `action_proposal` primero
- [ ] Frontend muestra `action_proposal` con botón de confirmación explícita por rol
- [ ] Todas las acciones ejecutadas vía propuesta aprobada se registran en `audit_log`

### Frontend
- [ ] `/app/asistente` — UI de chat con el orquestador, historial por sesión y acciones propuestas
