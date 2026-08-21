# Changelog — integración DIAN

Registro de incorporación y actualizaciones deliberadas de `dian-kit`, y de hitos propios de
ITCycle relacionados con la integración DIAN. No se actualiza automáticamente: cada entrada
corresponde a una revisión manual (changelog upstream, diff, tests, sandbox) antes de mover el
puntero del submódulo.

## 2026-08-21

- Se incorpora `sergioarojasm98/dian-kit` como submódulo git en `./dian-kit`, pinneado al commit
  `15573c9c7190e4ae492f02158501d16bbd283ce7`.
- Se valida que el proyecto original compila y pasa sus 215 tests sin modificaciones
  (`pnpm install`, `pnpm build`, `pnpm test`).
- No se ha ejecutado todavía ningún envío real contra el Sandbox de la DIAN desde ITCycle: falta
  una empresa de prueba habilitada (credenciales DIAN + certificado .p12 de prueba).
- Se documenta la arquitectura de `dian-kit` en [`compatibility.md`](./compatibility.md).
