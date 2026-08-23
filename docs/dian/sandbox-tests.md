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

## Aprovisionamiento de empresas (`src/modules/admin/`)

Antes de que una empresa pueda usar los endpoints de producción, necesita su propia `Company` +
`DianConfiguration` + `NumberingResolution` (una por `documentType`) + `Certificate` + `ApiKey` en esta
base de datos — el aislamiento por API key (una key = una empresa) es intencional, así que no hay forma
de "compartir" configuración entre empresas. Los endpoints admin (protegidos por `ADMIN_API_KEY`,
distinto de `DEV_API_KEY` — pensados para que los llame el backend de Ohnix, nunca un cliente final)
cubren ese alta de punta a punta:

```bash
ADMIN_KEY="x-admin-api-key: $ADMIN_API_KEY"

# 1. Empresa (idempotente por nit+dv)
curl -X POST http://localhost:3000/api/v1/admin/companies -H "$ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"...", "nit":"...", "dv":"...", "personType":"1"}'

# 2. Configuración DIAN (upsert)
curl -X PUT http://localhost:3000/api/v1/admin/companies/<id>/dian-configuration -H "$ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"environment":"SANDBOX","softwareId":"...","softwarePin":"...","technicalKey":"...","supplierProfile":{...}}'

# 3. Numeración (una llamada por documentType: "01", "91", "92")
curl -X POST http://localhost:3000/api/v1/admin/companies/<id>/numbering-resolutions -H "$ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"documentType":"01","prefix":"...","resolutionNumber":"...","startNumber":1,"endNumber":1000,"startDate":"...","endDate":"..."}'

# 4. Certificado (.p12 en base64 — nunca se devuelve en la respuesta)
curl -X POST http://localhost:3000/api/v1/admin/companies/<id>/certificates -H "$ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"firmapass","certificateIdentifier":"...","p12Base64":"...","password":"...","expiresAt":"..."}'

# 5. API key de la empresa (se muestra en texto plano una sola vez)
curl -X POST http://localhost:3000/api/v1/admin/companies/<id>/api-keys -H "$ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"label":"Ohnix production"}'
```

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
- Protegidos por `requireApiKey` (`src/shared/apiKeyAuth.ts`), **no** por `requireDevApiKey` — cada key
  está atada 1:1 a una `Company` (modelo `ApiKey`), y `companyId` siempre se deriva de la key
  autenticada (`request.company.id`), nunca del body/query. Generar una con:

  ```bash
  COMPANY_ID=<id> LABEL="descripcion" pnpm tsx scripts/create-api-key.ts
  ```

  La key se imprime en texto plano **una sola vez** — solo su hash SHA-256 se persiste. Guárdala de
  inmediato; si se pierde, hay que generar una nueva.

`pnpm db:seed:test-company` ahora también siembra (o, en modo `SIMULATE=true`, fabrica) numeración
`documentType="91"`/`"92"` para poder probar notas crédito/débito contra la misma empresa de prueba;
para una empresa real, solo lo hace si se definen `DIAN_TEST_CN_PREFIX`/`_AUTH_NUMBER`/`_START_NUMBER`/
`_END_NUMBER` (y el equivalente `DIAN_TEST_DN_*` para nota débito).

```bash
# Factura — companyId ya no va en el body, lo determina la API key
curl -X POST http://localhost:3000/api/v1/documents/invoices \
  -H "x-api-key: $ITCYCLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"internalReference":"...","invoice":{...},"send":{"method":"SendTestSetAsync","testSetId":"..."}}'

# Nota crédito, referenciando la factura ya ACCEPTED de arriba
curl -X POST http://localhost:3000/api/v1/documents/credit-notes \
  -H "x-api-key: $ITCYCLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"internalReference":"...","invoiceId":"<invoice id devuelto arriba>","document":{...},"discrepancyResponse":{"responseCode":"2","description":"..."},"send":{"method":"SendTestSetAsync","testSetId":"..."}}'

# Estado de un documento ya emitido
curl http://localhost:3000/api/v1/documents/invoices/<id> -H "x-api-key: $ITCYCLE_API_KEY"
```

Certificados: por defecto los servicios de producción usan `EncryptedFileCertificateSecretStore`
(AES-256-GCM) si `CERTIFICATE_ENCRYPTION_KEY` está configurada; si no, caen a
`LocalFileCertificateSecretStore` (texto plano, dev-only — nunca en un despliegue real).

## Contingencia (solo el caso "atribuible a la DIAN")

Cubre exactamente el escenario en que el servicio de la DIAN no responde (timeout, error de red, HTTP
no-2xx) — lo que `@dian-kit/sdk-node` siempre señaliza lanzando `DianTransportError` desde `send()`.
**No** cubre el otro caso que reconoce la normativa (falla atribuible al propio facturador, con
numeración de contingencia en papel/talonario y transcripción manual a XML dentro de 30 días) — eso
sigue pendiente, es un flujo de negocio distinto (alguien factura a mano), no una reacción automática
del sistema.

Cuando `send()` lanza `DianTransportError`, el documento (ya construido y firmado — CUFE/CUDE incluido)
queda en estado `CONTINGENCY` en vez de `ERROR`: el XML firmado se persiste vía `DocumentXmlStore`
(`DOCUMENTS_DIR`, `LocalFileDocumentXmlStore` por defecto) y el número/CUFE ya se le puede entregar al
cliente, tal como exige la normativa ("debe generar y entregar la factura... sin la validación de la
DIAN"). Cualquier otro error en `send()` que no sea `DianTransportError` sigue marcando `ERROR` — la
clasificación es por tipo de excepción, nunca una suposición.

Reintentar el envío una vez restablecido el servicio:

```bash
curl -X POST http://localhost:3000/api/v1/documents/invoices/<id>/retry-send \
  -H "x-api-key: $ITCYCLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"send":{"method":"SendTestSetAsync","testSetId":"..."}}'
```

Reutiliza el **mismo** XML ya firmado (nunca se regenera — la firma XAdES-EPES lleva timestamp, así que
regenerarlo produciría un documento distinto al que ya recibió el cliente). Si la DIAN sigue sin
responder, el documento se queda en `CONTINGENCY`; si responde, transiciona a `ACCEPTED`/`REJECTED`. Un
`REJECTED` alcanzado por esta vía **no invalida** retroactivamente el documento ya entregado al
cliente — es una distinción de proceso/soporte, no un estado adicional en la máquina de estados.

### Reintento automático (sin cola, `src/jobs/contingencyRetry.job.ts`)

Un job periódico (`node-cron`, controlado por `CONTINGENCY_RETRY_CRON` — cada 10 minutos por defecto)
recorre **todas** las empresas y reintenta cada factura/nota crédito/nota débito en `CONTINGENCY`,
usando exactamente la misma lógica que el endpoint `/retry-send`. Deliberadamente no se introdujo una
cola tipo BullMQ/Redis: a este volumen (los eventos de contingencia deberían ser raros — una caída de la
DIAN, no tráfico rutinario) un barrido periódico simple es proporcional. Un documento que falla nunca
detiene el barrido de los demás (cada reintento está aislado en su propio try/catch). Desactivar con
`START_SCHEDULER=false` (útil para tests o scripts puntuales).

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
