# Modo simulado (`DIAN_SIMULATION_MODE`)

Desbloquea desarrollo/demos locales de todo lo que rodea al envío a la DIAN, sin depender de tener
ya una empresa habilitada de verdad. **No es, ni sustituye, el criterio de éxito de la Fase 4**
(`docs/dian/sandbox-tests.md`) — una factura `ACCEPTED` en modo simulado nunca fue validada por la
DIAN.

## Qué es real y qué no

`SimulatedDianProvider` (`src/providers/dian/SimulatedDianProvider.ts`) delega
`createInvoice`/`createCreditNote`/`createDebitNote` a un `DianKitProvider` real: el XML UBL 2.1,
el cálculo de CUFE/CUDE y la firma XAdES-EPES son 100% genuinos, generados por `dian-kit` sin
ningún cambio ni atajo. Lo único que se simula es `send`/`getStatus`/`getStatusZip`: en vez de
llamar al servicio SOAP real de la DIAN, se devuelve una respuesta local `isValid: true,
statusCode: "00"` — porque esa llamada solo puede tener éxito contra una habilitación real (NIT,
Software ID/PIN, resolución de numeración, clave técnica, certificado emitido por una CA ONAC).
`getNumberingRange`/`lookupBuyer` no se simulan: lanzan un error explícito, porque simularlos
implicaría inventar datos del registro de la DIAN.

## Cómo activarlo

1. Sembrar una empresa completamente local (certificado autofirmado vía `generateTestP12` de
   `dian-kit`, NIT y credenciales obviamente ficticias):

   ```bash
   SIMULATE=true pnpm db:seed:test-company
   ```

2. Levantar el servidor con el flag activo:

   ```bash
   DIAN_SIMULATION_MODE=true pnpm dev
   ```

3. Llamar a `POST /api/v1/dian/test-invoice` normalmente (ver `docs/dian/sandbox-tests.md`). La
   respuesta y el registro `Invoice` persistido traen `simulated: true` — es la única señal fiable
   de que no fue una aceptación real; no confiar en el `status` por sí solo.

Verificado de punta a punta el 2026-08-22: la empresa simulada, el certificado autofirmado, y la
factura completa (XML, CUFE real, firma) se generaron correctamente y quedaron marcadas
`status: "ACCEPTED", simulated: true`, sin ningún intento de contactar a la DIAN real. Los datos de
esa prueba se limpiaron después de verificar.

## Cuándo dejar de usarlo

En cuanto exista una empresa de prueba real habilitada ante la DIAN, usar
`pnpm db:seed:test-company` (sin `SIMULATE`) con las variables `DIAN_TEST_*` reales y correr el
servidor sin `DIAN_SIMULATION_MODE`. Ver `docs/dian/sandbox-tests.md` para el criterio de éxito
real de la Fase 4.
