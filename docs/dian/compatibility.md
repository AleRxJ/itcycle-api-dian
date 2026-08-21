# Compatibilidad — ITCycle DIAN API

Registro de versiones y compatibilidad entre DIAN, `dian-kit` (motor) e ITCycle (plataforma propia).

## Estado actual

| Componente | Versión / Referencia |
|---|---|
| `dian-kit` (submódulo) | commit `15573c9c7190e4ae492f02158501d16bbd283ce7` (rama `main` del upstream, 2026-05-25) |
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

- 2026-08-21: se incorpora `dian-kit` como submódulo de git en `./dian-kit`, pinneado al commit
  `15573c9c`. `pnpm install`, `pnpm build` y `pnpm test` (215 tests) verificados localmente sin
  modificar el código fuente del motor.

## Issues conocidos

- En Windows, `pnpm install` inicial puede no traer el binding nativo
  `@rolldown/binding-win32-x64-msvc` requerido por Vitest 4/Rolldown, causando que `pnpm test`
  falle con `MODULE_NOT_FOUND`. Solución: `pnpm install --force` para forzar la resolución de
  dependencias opcionales específicas de plataforma. No es un problema de `dian-kit`.
