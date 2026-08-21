# Pruebas Sandbox — ITCycle DIAN API

Registro de ejecuciones contra el ambiente de Habilitación (Sandbox) de la DIAN
(`https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc`).

## Cómo ejecutar (referencia, `dian-kit`)

Las pruebas de integración de `dian-kit` contra el Sandbox real están en
[`dian-kit/packages/core/tests/integration/dian-sandbox.test.ts`](../../dian-kit/packages/core/tests/integration/dian-sandbox.test.ts).
Están deshabilitadas por defecto y requieren las siguientes variables de entorno (empresa de
prueba habilitada ante la DIAN):

- `DIAN_TEST_CREDENTIALS=true`
- `DIAN_TEST_NIT`, `DIAN_TEST_NIT_DV`
- `DIAN_TEST_PASSWORD`
- `DIAN_TEST_SOFTWARE_ID`, `DIAN_TEST_SOFTWARE_PIN`
- `DIAN_TEST_SET_ID`
- `DIAN_TEST_P12_PATH`, `DIAN_TEST_P12_PASSWORD`
- `DIAN_TEST_TECH_KEY`
- `DIAN_TEST_AUTH_NUMBER`, `DIAN_TEST_PREFIX`, `DIAN_TEST_START_NUMBER`, `DIAN_TEST_END_NUMBER`
- `DIAN_TEST_PROVIDER_NIT`

Comando: `pnpm --filter @dian-kit/core test:integration` (desde `dian-kit/`).

**No usar credenciales ni certificados de clientes reales de Ohnix aquí.** Únicamente una empresa
de prueba dedicada a habilitación.

## Bitácora de ejecuciones

| Fecha | Ejecutado por | Empresa de prueba | Documento | CUFE/CUDE | trackId | Resultado | Notas |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | Aún no se ha ejecutado ninguna prueba Sandbox desde ITCycle. |

## Criterio de éxito (primer hito)

Una factura electrónica (tipo 01) enviada vía `SendTestSetAsync` (o `SendBillSync`/`SendBillAsync`
según corresponda) al Sandbox, con respuesta `isValid: true` y `statusCode: "00"`, registrada en
esta tabla junto con el XML enviado y la respuesta cruda de la DIAN.
