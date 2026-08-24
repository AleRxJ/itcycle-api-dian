import Fastify from "fastify";

import { startContingencyRetryScheduler } from "./jobs/contingencyRetry.job.js";
import { startFirmaPassIssuanceScheduler } from "./jobs/firmaPassIssuance.job.js";
import { registerAdminRoutes } from "./modules/admin/admin.route.js";
import { registerCreditNoteRoutes } from "./modules/documents/creditNote.route.js";
import { registerDebitNoteRoutes } from "./modules/documents/debitNote.route.js";
import { registerInvoiceRoutes } from "./modules/documents/invoice.route.js";
import { registerSupportDocumentRoutes } from "./modules/documents/supportDocument.route.js";
import { registerTestInvoiceRoute } from "./modules/invoices/test-invoice.route.js";
import { requireAdminApiKey } from "./shared/adminAuth.js";
import { requireApiKey } from "./shared/apiKeyAuth.js";
import { requireDevApiKey } from "./shared/devAuth.js";
import { env } from "./shared/env.js";

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

// Production document endpoints (factura, nota credito, nota debito).
// Gated by requireApiKey — each key is bound to exactly one Company (see
// src/shared/apiKeyAuth.ts, scripts/create-api-key.ts).
await app.register(async (documentRoutes) => {
  documentRoutes.addHook("onRequest", requireApiKey);
  await registerInvoiceRoutes(documentRoutes);
  await registerCreditNoteRoutes(documentRoutes);
  await registerDebitNoteRoutes(documentRoutes);
  await registerSupportDocumentRoutes(documentRoutes);
});

// Tenant provisioning (create Company/DianConfiguration/NumberingResolution/
// Certificate/ApiKey) — called only by Ohnix's own backend, never a customer.
await app.register(async (adminRoutes) => {
  adminRoutes.addHook("onRequest", requireAdminApiKey);
  await registerAdminRoutes(adminRoutes);
});

startContingencyRetryScheduler(app.log);
startFirmaPassIssuanceScheduler(app.log);

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
