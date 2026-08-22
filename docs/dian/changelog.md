# Changelog — integración DIAN

Registro de incorporación y actualizaciones deliberadas de `dian-kit`, y de hitos propios de
ITCycle relacionados con la integración DIAN. No se actualiza automáticamente: cada entrada
corresponde a una revisión manual (changelog upstream, diff, tests, sandbox) antes de mover el
puntero del submódulo.

## 2026-08-21

- Se incorpora `sergioarojasm98/dian-kit` como submódulo git en `./dian-engine`, pinneado al commit
  `15573c9c7190e4ae492f02158501d16bbd283ce7`.
- Se valida que el proyecto original compila y pasa sus 215 tests sin modificaciones
  (`pnpm install`, `pnpm build`, `pnpm test`).
- No se ha ejecutado todavía ningún envío real contra el Sandbox de la DIAN desde ITCycle: falta
  una empresa de prueba habilitada (credenciales DIAN + certificado .p12 de prueba).
- Se documenta la arquitectura de `dian-kit` en [`compatibility.md`](./compatibility.md).

## 2026-08-22

- Se renombra la carpeta del submódulo de `dian-kit/` a `dian-engine/` para que no suene tan
  parecido al nombre del propio producto ITCycle. Solo cambia la ruta local (`.gitmodules`, el
  `link:` en `package.json`, y las rutas mencionadas en `docs/`) — el repositorio upstream sigue
  siendo `sergioarojasm98/dian-kit` y los paquetes npm `@dian-kit/core`/`@dian-kit/sdk-node`
  conservan su nombre real.
