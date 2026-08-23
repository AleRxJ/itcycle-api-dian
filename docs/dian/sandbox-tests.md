# Pruebas Sandbox — ITCycle DIAN API

Registro de ejecuciones contra el ambiente de Habilitación (Sandbox) de la DIAN
(`https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc`).

## Cómo ejecutar (referencia, `dian-kit`)

Las pruebas de integración de `dian-kit` contra el Sandbox real están en
[`dian-engine/packages/core/tests/integration/dian-sandbox.test.ts`](../../dian-engine/packages/core/tests/integration/dian-sandbox.test.ts).
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

Comando: `pnpm --filter @dian-kit/core test:integration` (desde `dian-engine/`).

**No usar credenciales ni certificados de clientes reales de Ohnix aquí.** Únicamente una empresa
de prueba dedicada a habilitación.

## Cómo ejecutar (ITCycle)

Con las mismas variables `DIAN_TEST_*` de arriba (sin `DIAN_TEST_CREDENTIALS`, sin `DIAN_TEST_PASSWORD`
— esa es la contraseña del software DIAN, no del `.p12`), provisiona la empresa de prueba en la base
de datos de ITCycle:

```bash
DIAN_TEST_NIT=... DIAN_TEST_NIT_DV=... DIAN_TEST_SOFTWARE_ID=... DIAN_TEST_SOFTWARE_PIN=... \
DIAN_TEST_TECH_KEY=... DIAN_TEST_AUTH_NUMBER=... DIAN_TEST_PREFIX=... \
DIAN_TEST_START_NUMBER=... DIAN_TEST_END_NUMBER=... \
DIAN_TEST_P12_PATH=... DIAN_TEST_P12_PASSWORD=... \
pnpm db:seed:test-company
```

Esto crea `Company` + `DianConfiguration` (con `supplierProfile`) + `NumberingResolution` +
`Certificate`, y guarda el `.p12` a través de `CertificateSecretStore` en `CERTIFICATES_DIR`
(por defecto `./certs`, ignorado por git). El script imprime el `companyId` resultante y un
ejemplo de `curl`.

Luego, con el servidor corriendo (`pnpm dev`) y `DEV_API_KEY` configurado:

```bash
curl -X POST http://localhost:3000/api/v1/dian/test-invoice \
  -H "x-api-key: $DEV_API_KEY" -H "Content-Type: application/json" \
  -d '{"companyId":"<id>","internalReference":"...","invoice":{...},"send":{"method":"SendTestSetAsync","testSetId":"..."}}'
```

`invoice` sigue la forma de `InvoiceInput` de `@dian-kit/sdk-node` (ver
[`dian-engine/examples/basic-invoice.ts`](../../dian-engine/examples/basic-invoice.ts)), con
`issueDate`/`issueTime` como strings ISO. La petición es idempotente en
`(companyId, internalReference)`.

Este flujo fue verificado de punta a punta el 2026-08-21 con un certificado autofirmado de prueba
(`generateTestP12` de `dian-kit`): la empresa/configuración/numeración/certificado se cargan
correctamente, `createInvoice` firma sin error, y `send()` efectivamente llega al Sandbox real de
la DIAN (falla la autenticación por ser credenciales falsas, como se esperaba). Falta repetirlo con
una empresa de prueba real habilitada ante la DIAN para completar el criterio de éxito de abajo.

## Endpoints de producción (`src/modules/documents/`)

Desde 2026-08-23 existen endpoints de producción para factura, nota crédito y nota débito, además del
endpoint dev-only de arriba. Diferencias clave frente a `/api/v1/dian/test-invoice`:

- El número de documento **no** lo elige quien llama a la API: se reclama atómicamente del
  `currentNumber` de la `NumberingResolution` `ACTIVE` de la empresa para ese tipo de documento
  (`documentType`: `"01"` factura, `"91"` nota crédito, `"92"` nota débito). Cualquier `id` en el
  cuerpo de la petición se ignora.
- Nota crédito y nota débito reciben `invoiceId` (el id interno de la `Invoice` en la base de ITCycle,
  no un `billingReference` crudo) — el servicio exige que esa factura esté `ACCEPTED` y arma
  `billingReference`/`discrepancyResponse.referenceId` a partir de ella.
- Siguen protegidos por el mismo `requireDevApiKey` que el endpoint dev-only — la autenticación real
  multi-tenant (API key por empresa) es trabajo aparte, todavía no implementado.

`pnpm db:seed:test-company` ahora también siembra (o, en modo `SIMULATE=true`, fabrica) numeración
`documentType="91"`/`"92"` para poder probar notas crédito/débito contra la misma empresa de prueba;
para una empresa real, solo lo hace si se definen `DIAN_TEST_CN_PREFIX`/`_AUTH_NUMBER`/`_START_NUMBER`/
`_END_NUMBER` (y el equivalente `DIAN_TEST_DN_*` para nota débito).

```bash
# Factura
curl -X POST http://localhost:3000/api/v1/documents/invoices \
  -H "x-api-key: $DEV_API_KEY" -H "Content-Type: application/json" \
  -d '{"companyId":"<id>","internalReference":"...","invoice":{...},"send":{"method":"SendTestSetAsync","testSetId":"..."}}'

# Nota crédito, referenciando la factura ya ACCEPTED de arriba
curl -X POST http://localhost:3000/api/v1/documents/credit-notes \
  -H "x-api-key: $DEV_API_KEY" -H "Content-Type: application/json" \
  -d '{"companyId":"<id>","internalReference":"...","invoiceId":"<invoice id devuelto arriba>","document":{...},"discrepancyResponse":{"responseCode":"2","description":"..."},"send":{"method":"SendTestSetAsync","testSetId":"..."}}'

# Estado de un documento ya emitido
curl "http://localhost:3000/api/v1/documents/invoices/<id>?companyId=<id>" -H "x-api-key: $DEV_API_KEY"
```

Cobertura de pruebas: `src/modules/documents/*.service.test.ts` (mismo patrón que
`test-invoice.service.test.ts` — provider/secretStore falsos contra la base de datos real de
desarrollo), incluyendo el caso de rechazo al referenciar una factura no `ACCEPTED` y la verificación
de que la numeración nunca se repite ante una repetición idempotente.

## Bitácora de ejecuciones

| Fecha | Ejecutado por | Empresa de prueba | Documento | CUFE/CUDE | trackId | Resultado | Notas |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | Aún no se ha ejecutado ninguna prueba Sandbox desde ITCycle. |

## Criterio de éxito (primer hito)

Una factura electrónica (tipo 01) enviada vía `SendTestSetAsync` (o `SendBillSync`/`SendBillAsync`
según corresponda) al Sandbox, con respuesta `isValid: true` y `statusCode: "00"`, registrada en
esta tabla junto con el XML enviado y la respuesta cruda de la DIAN.
