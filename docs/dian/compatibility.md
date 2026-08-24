# Compatibilidad — ITCycle DIAN API

Registro de versiones y compatibilidad entre DIAN, `dian-kit` (motor) e ITCycle (plataforma propia).

## Estado actual

| Componente | Versión / Referencia |
|---|---|
| `dian-engine` (vendored de dian-kit) | basado en commit upstream `15573c9c7190e4ae492f02158501d16bbd283ce7` + parche local de Documento Soporte (`b2f5a41`, no publicado upstream) |
| `@dian-kit/core` | 1.0.1 |
| `@dian-kit/sdk-node` | 1.0.1 |
| ITCycle DIAN API | sin versionar todavía (pre-alpha) |
| Ambiente DIAN validado | Sandbox (`vpfe-hab.dian.gov.co`) — validado únicamente por el proyecto upstream, no todavía por ITCycle |
| Ambiente DIAN producción | No usado |
| UBL | 2.1 |
| Algoritmo CUFE/CUDE | SHA-384, según Anexo Técnico DIAN |
| Firma digital | XAdES-EPES |
| Transporte | SOAP con WS-Security Signature (`WcfDianCustomerServices.svc`) |

## Fecha de última prueba Sandbox (ITCycle)

Ninguna todavía. Se requiere una empresa de prueba habilitada ante la DIAN (NIT, Software ID/PIN,
resolución de numeración, clave técnica y certificado .p12) para ejecutar el primer envío real.
El proyecto upstream reporta haber validado el flujo con `isValid: true`, `statusCode: 00`, pero
eso no ha sido reproducido todavía dentro de este repositorio.

## Cambios relevantes

- 2026-08-21: se incorpora `dian-kit` como submódulo de git en `./dian-engine`, pinneado al commit
  `15573c9c`. `pnpm install`, `pnpm build` y `pnpm test` (215 tests) verificados localmente sin
  modificar el código fuente del motor.
- 2026-08-22: se renombra la carpeta del submódulo de `dian-kit/` a `dian-engine/` (solo la ruta
  local; el proyecto upstream y los paquetes npm `@dian-kit/core`/`@dian-kit/sdk-node` no cambian
  de nombre) para que no se confunda con el nombre del producto ITCycle.
- 2026-08-24: se elimina el git submodule. No se tienen permisos de push sobre
  `sergioarojasm98/dian-kit`, y ya se habían hecho cambios locales al motor (soporte para
  Documento Soporte, tipo "05") que no tenía sentido intentar subir allá. `dian-engine/` ahora es
  código vendored normal, tracked directamente en este repo — sin remoto externo. El historial
  git completo del submódulo (hasta el commit `b2f5a41`) quedó respaldado fuera del repo en
  `dian-engine-history-backup.bundle`, junto a `itcycle-api-dian/`. `itcycle-api-dian` y
  `dian-engine/packages/*` pasan a compartir un único pnpm workspace (`pnpm-workspace.yaml`), así
  un solo `pnpm install && pnpm build` compila todo — antes requería instalar/compilar
  `dian-engine` como proyecto aparte. Contrapartida: actualizar desde el upstream de dian-kit ya
  no es un `git submodule update`, hay que traer los cambios a mano.

## Issues conocidos

- En Windows, `pnpm install` inicial puede no traer el binding nativo
  `@rolldown/binding-win32-x64-msvc` requerido por Vitest 4/Rolldown, causando que `pnpm test`
  falle con `MODULE_NOT_FOUND`. Solución: `pnpm install --force` para forzar la resolución de
  dependencias opcionales específicas de plataforma. No es un problema de `dian-kit`.
