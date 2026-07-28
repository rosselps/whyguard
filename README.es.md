# WhyGuard

**Git recuerda qué cambió. WhyGuard reconstruye *por qué* — y evita que personas y agentes de IA borren esa razón por accidente.**

[English](./README.md) · [Cómo alimentarlo](./docs/guides/feeding-whyguard.md) · [Arquitectura](./docs/architecture/architecture.md)

```bash
npx whyguard demo        # verlo funcionar: sin cuenta, sin servidor, sin configuración
npx whyguard init        # proteger un repositorio propio
```

**Despliegue en marcha.** [Dashboard](https://main.d13s30epqvi33j.amplifyapp.com) ·
[el pull request que está leyendo](https://github.com/rosselps/whyguard-demo/pull/3). La
GitHub App analizó ese pull request y publicó el Check Run; el dashboard es el registro de
solo lectura de eso, no el producto. El producto es el comando de arriba.

---

## El problema

```ts
export function createOrder(idempotencyKey: string, amount: number): Order {
  const existing = existingOrders.get(idempotencyKey);
  if (existing) {
    return existing;          // <- parece redundante. Nadie recuerda por qué.
  }
  validateAmount(amount);
```

Alguien lo elimina. El mensaje del commit es sincero y completamente equivocado:

> `Simplify createOrder by removing redundant duplicate check`

Ese guard lo agregó el PR #493 ocho meses antes para resolver el Issue #481: los clientes
reintentan el checkout cuando la pasarela da timeout, el servidor ya cobró la tarjeta, y sin
ese guard al cliente se le cobra dos veces.

Los tests pasan. El linter está conforme. La cobertura no se mueve. El revisor aprueba en 40
segundos, porque el diff de verdad parece una simplificación.

Los agentes de IA agravan esto: son excelentes haciendo que el código parezca más limpio, y
no tienen ninguna memoria del incidente que puso ahí la parte fea.

## Qué hace

```
$ npx whyguard demo
```

```text
Step 2/3  Scanning that change the way a reviewer never has time to...

[CRITICAL] src/payments/create-order.ts :: createOrder
  kind: condition_removed
  risk: 96  confidence: 100
  reason: known
  protected property: One idempotency key creates at most one order.
  protected property: Retrying a completed request returns the existing order.
  evidence: [strong] payment-idempotency: confirmed issue #481
  evidence: [strong] payment-idempotency: confirmed pull_request #493
  evidence: [medium] Commit 11236a65e296: Enforce idempotency key on createOrder (fixes #481)
  evidence: [medium] Referenced in commit 11236a65e296: #481
  evidence: [weak]   Referenced in commit 11236a65e296: #493
```

Después, dentro de ese repositorio:

```
$ git commit -m "Simplify createOrder"
```

```text
WHYGUARD BLOCKED THIS COMMIT

Protected historical behavior was removed in staged changes:
src/payments/create-order.ts
  symbol: createOrder (condition_removed)
  protected property: One idempotency key creates at most one order.
  ...
```

El commit no ocurre. Cada pieza de evidencia de arriba es rastreable a algo commiteado en
ese repositorio: el archivo del contrato, el mensaje del commit, las referencias a issues
que contiene. Nada está prefabricado.

## Qué **no** hace

Ejecuta el segundo escenario. Misma herramienta, mismo tipo de cambio, respuesta distinta:

```bash
npx whyguard demo --scenario timeouts
```

Un repositorio donde alguien acortó un timeout y bajó los reintentos, y donde **nadie
escribió nunca por qué se eligieron esos valores**. Los mismos dos commits, analizados antes
y después de que un humano registre la decisión:

| | Severidad | Riesgo | Confianza | Veredicto |
|---|---|---|---|---|
| Solo historial de Git | HIGH | 70 | 65 | aviso |
| Con la decisión registrada | CRITICAL | 94.5 | 100 | **bloqueo** |

Un mensaje de commit que menciona un issue es una pista. WhyGuard la reporta, la puntúa y la
explica — y no va a rechazar tu commit por una pista. Solo una decisión que un humano
escribió produce evidencia `strong`, y solo la evidencia `strong` puede bloquear.

Ese es el insumo que la herramienta necesita de ti, y es un archivo YAML:
[Cómo alimentar a WhyGuard](./docs/guides/feeding-whyguard.md).

## Cómo decide

Lógica determinista de Git y AST. Ningún modelo participa en la decisión.

```text
¿qué cambió?         comparación AST con ts-morph, no diff de texto
                     "se eliminó un guard clause de createOrder", no "cambiaron 5 líneas"

¿por qué existe?     git log -S encuentra el commit que INTRODUJO la lógica eliminada,
                     y de ahí su mensaje, PRs e issues
                     .whyguard/decisions/*.yml si un humano lo confirmó

¿qué tan seguros?    fuerza de evidencia: el ítem más fuerte + 5 por cada corroboración

¿qué pasa?           riesgo >= 80 Y confianza >= 75 Y evidencia strong Y una propiedad
                     protegida Y ningún test de regresión equivalente  ->  BLOQUEO
```

```text
riesgo = 0.25 * criticidadDelModulo    + 0.20 * severidadHistorica
       + 0.20 * fuerzaDeEvidencia      + 0.15 * faltaTestDeRegresion
       + 0.10 * magnitudDelCambio      + 0.10 * senalDeIncidenteRepetido
```

Dos decisiones a las que se llegó equivocándose primero:

**La confianza usa la evidencia más fuerte, no el promedio.** Promediar castigaba la
corroboración: un contrato confirmado (95) más una referencia débil de commit (25)
promediaba 60, por debajo del umbral de bloqueo — así que *encontrar más evidencia hacía que
WhyGuard bloqueara menos*.

**Los cambios cosméticos no producen findings, a propósito.** Renombrar identificadores,
paréntesis redundantes, argumentos reformateados y *subir* un contador de reintentos se
ignoran todos. Un guardrail que grita por un rename se desinstala en una semana, y entonces
no protege nada.

## Las capas no son igual de fuertes

WhyGuard protege el mismo comportamiento en cuatro momentos. Ofrecen garantías realmente
distintas, y tratarlas como equivalentes es la forma más fácil de tener una falsa sensación
de seguridad:

| Capa | Comando | Quién impone el bloqueo | ¿Un agente puede ignorarlo? |
|---|---|---|---|
| Hook `PreToolUse` de Kiro | `whyguard hook --on-block ask` | El IDE Kiro, preguntando al humano | No el prompt — ver abajo |
| Hook `Stop` de Kiro | `whyguard verify --scope working-tree` | Nadie; reporta lo que ya pasó | Es un reporte, no una puerta |
| `pre-commit` de Git | `whyguard verify --scope staged` | **Git aborta el commit él mismo** | **No** |
| Check de PR en GitHub | la GitHub App | GitHub, del lado del servidor | **No** |

Un hook `PreToolUse` que escribe en STDERR y sale con `2` es solo *advisory*. Probado en el
IDE Kiro con dos modelos (MiniMax M2.5 y DeepSeek v3.2): el hook se disparó, devolvió `2`
con el feedback completo del bloqueo, y **ambos modelos aplicaron igual la edición que
eliminaba el comportamiento protegido** — uno explicó después que había quitado la
protección de idempotencia.

Por eso `whyguard hook` usa `--on-block ask` por defecto: devuelve un `permissionDecision`
de Kiro y hace que el *IDE* le pregunte al humano. Un agente puede ignorar un código de
salida. No puede hacer clic por ti en tu diálogo de confirmación.

La salida de emergencia humana es deliberada y visible: `WHYGUARD_SKIP=1 git commit`. El
objetivo nunca fue hacer imposible la eliminación, solo hacerla imposible **por accidente**.

## Esto no es una herramienta solo para Kiro

Dos de las cuatro capas no tienen editor dentro, y una tercera habla un protocolo estándar:

| Superficie | De qué depende | Dónde funciona |
|---|---|---|
| `pre-commit` de Git | Git | Cualquier editor, y también sin editor |
| Check Run de GitHub | un webhook firmado | En el servidor; el editor es irrelevante |
| Servidor MCP | `@modelcontextprotocol/sdk` sobre stdio | Cualquier cliente MCP, sin cambios |
| Intercepción antes de escribir | la API de hooks del anfitrión | Un adaptador fino por anfitrión |

Solo la intercepción antes de escribir depende del anfitrión, y no es una decisión de diseño:
no existe una API común entre editores para «una herramienta va a escribir este archivo». Por
eso el núcleo recibe una petición neutral. `whyguard guard --stdin` lee un `GuardRequest`
—raíz del repositorio, ruta del archivo, contenido propuesto— y el único trabajo de un
adaptador es mapear el evento del anfitrión a esos campos. `whyguard hook` es ese adaptador
para Kiro, y hoy el único que se distribuye.

Kiro, Claude Code y Cursor siguen el mismo patrón —JSON por stdin, la decisión por stdout o
por el código de salida—, así que cada adaptador nuevo es un renombrado de campos, no un
rediseño. El mapeo por anfitrión, y qué hacer en uno que no expone nada antes de escribir,
está en [Anfitriones de agentes](./docs/guides/agent-hosts.md).

Lo que todavía no existe, dicho claramente: adaptadores para Claude Code y Cursor, y
`whyguard init --host <nombre>`. Y conviene decir que una extensión de VS Code encaja peor de
lo que parece: la escritura que interesa interceptar viene de la extensión de agente que el
usuario haya instalado, y una segunda extensión no puede verla. La palanca está en el
anfitrión del agente, no en el editor.

## Por qué no basta con lo que ya existe

| Herramienta | Qué sabe | Qué le falta |
|---|---|---|
| Linters, type checkers | Reglas sobre la forma del código | Nada de tu historial de incidentes |
| Cobertura de tests | Que una línea se ejecuta | Si una línea *eliminada* importaba |
| `CODEOWNERS`, revisión | A quién preguntar | Si el revisor aún recuerda 2024 |
| ADRs, documentación | Decisiones, en una carpeta que nadie abre | El vínculo entre la decisión y la línea |
| `git blame` | Quién tocó la línea al final | Por qué se introdujo la lógica, si un refactor la movió |

La razón ya está en tu repositorio, dispersa entre mensajes de commit, descripciones de PR y
referencias a issues. Lo que no está es *accesible* en el momento en que alguien va a
borrarla.

## Comandos

| Comando | Qué hace |
|---|---|
| `whyguard demo [--scenario payments\|timeouts]` | Recorrido autocontenido. `--list` para ver todos |
| `whyguard init` | Conecta todas las barreras en un repositorio, en un comando |
| `whyguard trace <archivo>:<símbolo>` | Qué se sabe de un símbolo, **antes** de editarlo |
| `whyguard scan --base <ref> --head <ref>` | Analiza un rango de Git |
| `whyguard verify --scope staged\|working-tree` | Revisa trabajo sin commitear; sale con `2` si bloquea |
| `whyguard install-hooks` | Instala solo el hook `pre-commit` de Git |
| `whyguard guard --stdin` / `whyguard hook` | Evalúa una edición propuesta (lo que llama el hook de Kiro) |

`whyguard init` es idempotente, hace merge sobre configuraciones existentes y nunca
reemplaza en silencio un archivo que no reconoce. Conecta el hook `pre-commit` de Git, los
hooks `PreToolUse`/`Stop` de Kiro, la configuración del servidor MCP y una plantilla de
contrato inactiva.

## Superficies

- **CLI** — la tabla de arriba. Sin configuración, sin red, funciona offline.
- **Kiro** — un hook `PreToolUse` que pregunta antes de una edición protegida, un hook
  `Stop` que reporta lo que un turno eliminó, y un **servidor MCP** con
  `whyguard.scan_diff`, `trace_symbol`, `get_finding`, `list_protected_properties`,
  `propose_regression_test` y `register_decision` (la única herramienta de escritura, detrás
  de un `confirm: true` explícito).
- **GitHub App** — en `pull_request.opened`/`synchronize`/`reopened` clona el PR, ejecuta el
  mismo núcleo determinista y publica un Check Run. Verificado contra un PR real.
- **Dashboard** — UI de investigación de solo lectura: qué se analizó, qué comportamiento
  está protegido, la línea de tiempo de evidencia, y un esqueleto de test de regresión a
  demanda. Nunca dispara un análisis, nunca escribe, y nunca genera ni ejecuta un test solo.

## Explicaciones: primero determinista, el modelo después

Cada finding recibe una explicación sin que participe ningún modelo, construida desde la
evidencia del propio finding. Ese es el camino por defecto y el único que usa el CLI de
fábrica.

Amazon Bedrock es opt-in (`WHYGUARD_LLM_ENABLED=true` más `AWS_REGION` y `BEDROCK_MODEL_ID`)
y solo *reformula* lo que el núcleo determinista ya decidió. No puede cambiar un score ni un
veredicto, y su salida se trata como no confiable:

1. debe parsear como JSON,
2. debe validar contra `LlmExplanationSchema`,
3. **no puede citar un ID de evidencia ausente del finding** — la verificación
   anti-alucinación que un schema no puede expresar.

Cualquier fallo en cualquier paso cae al template determinista. La UI siempre muestra un
badge indicando qué camino produjo el texto, así que "¿esto lo escribió un modelo?" nunca es
una suposición.

## Alcance, con honestidad

- **Solo TypeScript y JavaScript.** El detector está construido sobre `ts-morph`.
- **Sin auto-fix y sin tests generados.** Propone un esqueleto para que un humano lo
  complete. Un guardrail que escribe sus propios tests puede escribir el equivocado y luego
  aprobarse a sí mismo.
- **Sin extensión de IDE.** La integración con Kiro es MCP más hooks.
- **Bloquear requiere una decisión escrita.** Por diseño, ver arriba.
- **No reemplaza tests, revisión ni ADRs.** Cubre el hueco que los tres comparten: el
  momento en que el código cambia y la razón no está en la sala.

Detecta: guard clause eliminado, llamada de validación eliminada, cambio de límite u
operador, retry eliminado o reducido, timeout modificado. Huecos conocidos: ramas de caso
especial, y tests debilitados en lugar de eliminados. Se verifica que los `required_tests`
existan, pero WhyGuard nunca ejecuta ni parsea tus tests. `expires_when` se guarda y se
muestra, pero todavía no se puntúa.

## AWS y Kiro

| Componente | Servicio | Notas |
|---|---|---|
| Explicaciones | Amazon Bedrock | Opt-in, validado por schema, con fallback determinista |
| Dashboard | AWS Amplify Hosting | Build estático |
| API + receptor de webhooks | Amazon EC2 | Necesita directorio persistente para los clones |

Kiro se usa dentro del producto, no solo para construirlo: el hook `PreToolUse` devuelve un
`permissionDecision` de Kiro, y el servidor MCP le permite a un agente preguntar "¿qué está
protegido aquí?" antes de editar. El repositorio también incluye políticas en
`.kiro/steering/` y tres `.kiro/skills/`.

**Por qué los clones son completos.** El pickaxe *es* el producto, así que `--depth` queda
descartado. `--filter=blob:none` se probó y se rechazó por medición, con `sindresorhus/got`
(1664 commits):

| Clon | En disco | `git log -S` con path |
|---|---|---|
| completo | 5.9 MB | 0.07s |
| `--filter=blob:none --no-tags` | 3.5 MB | **186.58s** |

Resultados idénticos, 2.4 MB ahorrados, ~2600x más lento, porque el pickaxe va a la red por
cada blob que no tiene. El disco se protege en cambio con un techo de tamaño de repositorio
(`WHYGUARD_MAX_REPO_SIZE_MB`, verificado antes de clonar) y una limpieza al arrancar de los
workspaces que dejó abandonados un proceso que murió a mitad de análisis.

## Desarrollo local

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint

pnpm --filter @whyguard/api dev         # receptor de webhooks + API del dashboard (requiere .env)
pnpm --filter @whyguard/dashboard dev   # http://localhost:5173
```

Postura de seguridad de la API: guard de bearer token con `timingSafeEqual` que **falla
cerrado a solo loopback** cuando no hay token configurado, rate limiting por ruta, cabeceras
de seguridad, e identificadores de repositorio guardados como `owner/repo` para que las
rutas del servidor nunca se filtren en los reportes.

```text
apps/
  cli/            CLI whyguard
  mcp-server/     servidor MCP (6 herramientas; 1 de escritura, con confirmación)
  api/            webhooks de la GitHub App + Check Runs + API de lectura del dashboard
  dashboard/      UI de investigación en Vite + React
packages/
  contracts/      schemas Zod / DTOs compartidos
  domain/         fórmulas de riesgo y confianza, regla de bloqueo, transiciones de estado
  git-adapter/    wrappers de Git con arrays de argumentos (sin interpolación de shell)
  github-adapter/ auth de la App, lectura de PRs, Check Runs, firma de webhooks
  ast-adapter/    detector de cambios sensibles con ts-morph
  application/    casos de uso scan-diff, trace-symbol, guard-change, scan-pull-request
  llm-adapter/    Bedrock + validación de schema + fallback determinista
  persistence-adapter/  SQLite (node:sqlite)
  test-fixtures/  constructores de repositorios de demo
```

## Documentación

- [Cómo alimentar a WhyGuard](./docs/guides/feeding-whyguard.md) — cada insumo que lee y las convenciones que conviene adoptar
- [Anfitriones de agentes](./docs/guides/agent-hosts.md) — el contrato de integración y el mapeo para Kiro, Claude Code y Cursor
- [Arquitectura](./docs/architecture/architecture.md) — componentes, flujo de datos, límites de confianza
- [UI/UX del dashboard](./docs/design/ui-ux.md) — sistema visual, tokens, reglas de pantalla
- [Despliegue en AWS](./docs/deploy/aws.md) — API en EC2, dashboard en Amplify
- [Escenarios de prueba manual](./docs/demo/manual-test-scenarios.md) — verificación paso a paso de cada superficie
- [`README.md`](./README.md) — este documento en inglés
- [`AGENTS.md`](./AGENTS.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## Equipo

Hecho para el Hackathon IA Masivo Online AWS (Código Facilito × AWS), julio de 2026.

| | |
| --- | --- |
| Rossel Perez | psrosseli@gmail.com |
| Marco Chumbes | markitos02chum@gmail.com |
| José Huarcaya | josemariahuarcaya2002@outlook.es |
| Jhory Valvidia | wifi.arzuz@gmail.com |

Licencia MIT.
