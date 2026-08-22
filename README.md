# itcycle-api-dian

Infraestructura propia de facturación electrónica para Colombia (DIAN), construida inicialmente
para Ohnix, con la meta de convertirse en un producto independiente ("ITCycle DIAN API") que
otros sistemas (POS, ERP, SaaS) puedan consumir y eventualmente pagar por documento procesado.

## Arquitectura

```
ITCycle (src/)
   │  API, multiempresa, certificados, idempotencia, estados
   ▼
DianProvider                     ← abstracción propia (src/providers/dian/)
   │
   ├── DianKitProvider            → motor real
   └── SimulatedDianProvider      → motor real + envío simulado (solo dev/demo)
   ▼
dian-engine/                     ← submódulo git de sergioarojasm98/dian-kit (MIT)
   │  UBL 2.1, firma XAdES-EPES, CUFE/CUDE, SOAP/WS-Security
   ▼
DIAN
```

`dian-engine/` es el motor técnico de facturación electrónica: se usa tal cual, sin
modificaciones, y se actualiza deliberadamente (nunca automático) — ver
[`docs/dian/compatibility.md`](docs/dian/compatibility.md). Es el mismo proyecto open source
`sergioarojasm98/dian-kit`, solo renombrado localmente para no confundirse con el nombre del
producto ITCycle; los paquetes npm que expone conservan su nombre real
(`@dian-kit/core`, `@dian-kit/sdk-node`).

Todo lo demás — API, tenants, configuración DIAN por empresa, certificados, idempotencia,
estados, futura API pública y cobro por documento — es código propio de ITCycle en `src/`. La
regla de separación completa está en [`docs/dian/compatibility.md`](docs/dian/compatibility.md)
y en los comentarios de `src/providers/dian/`.

## Stack

Node.js 20+, TypeScript, Fastify, PostgreSQL vía Prisma, pnpm.

## Setup

```bash
git clone --recurse-submodules <url>
# o, si ya clonaste sin submódulos:
git submodule update --init --recursive

corepack enable
corepack prepare pnpm@9.15.4 --activate

# el motor DIAN se instala/compila por separado, como proyecto independiente
cd dian-engine && pnpm install && pnpm build && cd ..

pnpm install
cp .env.example .env   # completa DATABASE_URL, DEV_API_KEY, etc.
pnpm db:migrate
pnpm dev
```

## Scripts principales

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Servidor Fastify en modo desarrollo (`/health`, `/api/v1/dian/test-invoice`) |
| `pnpm build` / `pnpm start` | Compila y ejecuta la build de producción |
| `pnpm test` | Suite de pruebas propia de ITCycle (`src/**/*.test.ts`) — el motor tiene la suya dentro de `dian-engine/` |
| `pnpm typecheck` | `tsc --noEmit` sobre todo `src/`, incluyendo tests |
| `pnpm db:migrate` / `pnpm db:studio` | Migraciones Prisma / explorador de la base de datos |
| `pnpm db:seed:test-company` | Provisiona una empresa de prueba (real, con credenciales `DIAN_TEST_*`, o `SIMULATE=true` para una 100% local) |

## Estado actual y próximos pasos

Ver [`docs/dian/`](docs/dian/):

- [`compatibility.md`](docs/dian/compatibility.md) — versión de `dian-engine` en uso, estado de compatibilidad
- [`sandbox-tests.md`](docs/dian/sandbox-tests.md) — cómo probar contra el Sandbox real de la DIAN, criterio de éxito de la primera factura aceptada
- [`simulation.md`](docs/dian/simulation.md) — modo simulado para desarrollar/demostrar sin credenciales DIAN reales
- [`technical-annexes.md`](docs/dian/technical-annexes.md) — fuentes oficiales DIAN y proceso de actualización del motor
- [`changelog.md`](docs/dian/changelog.md) — bitácora de incorporación del motor y cambios relevantes

El primer hito pendiente no es técnico: falta una empresa de prueba real habilitada ante la DIAN
(NIT, Software ID/PIN, resolución de numeración, clave técnica, certificado `.p12` de una CA
ONAC) para completar el criterio de éxito de la Fase 4. Mientras tanto, `DIAN_SIMULATION_MODE`
permite construir y demostrar todo el flujo alrededor de eso.

## Licencia

El código en `src/` es privado. `dian-engine/` es un submódulo de
[`sergioarojasm98/dian-kit`](https://github.com/sergioarojasm98/dian-kit), licenciado MIT — su
aviso de copyright original se mantiene intacto dentro de esa carpeta.
