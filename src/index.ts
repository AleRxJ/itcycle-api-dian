import Fastify from "fastify";

import { registerCreditNoteRoutes } from "./modules/documents/creditNote.route.js";
import { registerDebitNoteRoutes } from "./modules/documents/debitNote.route.js";
import { registerInvoiceRoutes } from "./modules/documents/invoice.route.js";
import { registerTestInvoiceRoute } from "./modules/invoices/test-invoice.route.js";
import { env } from "./shared/env.js";
import { requireDevApiKey } from "./shared/devAuth.js";

const app = Fastify({
  logger:
    env.nodeEnv === "development"
      ? { transport: { target: "pino-pretty" } }
      : true,
});

app.get("/health", async () => ({ status: "ok" }));

await app.register(async (devRoutes) => {
  devRoutes.addHook("onRequest", requireDevApiKey);
  await registerTestInvoiceRoute(devRoutes);
});

// Production document endpoints (factura, nota credito, nota debito). Still
// gated by requireDevApiKey — real per-company API-key auth is separate,
// not-yet-implemented work (see the fiscal audit's backlog), not part of
// this change.
await app.register(async (documentRoutes) => {
  documentRoutes.addHook("onRequest", requireDevApiKey);
  await registerInvoiceRoutes(documentRoutes);
  await registerCreditNoteRoutes(documentRoutes);
  await registerDebitNoteRoutes(documentRoutes);
});

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
