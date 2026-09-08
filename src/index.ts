import Fastify from "fastify";

import { CertificateProviderTechnicalError } from "./providers/certificates/CertificateProviderRegistry.js";
import { startContingencyRetryScheduler } from "./jobs/contingencyRetry.job.js";
import { startFirmaPassIssuanceScheduler } from "./jobs/firmaPassIssuance.job.js";
import { startViafirmaIssuanceScheduler } from "./jobs/viafirmaIssuance.job.js";
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
import { reconcileOrphanedProcessingDocuments } from "./shared/startupReconcile.js";

const app = Fastify({
  logger:
    env.nodeEnv === "development"
      ? { transport: { target: "pino-pretty" } }
      : true,
});

app.get("/health", async () => ({ status: "ok" }));

// A CertificateProviderTechnicalError's own `.message` is already a clean,
// English, user-safe summary (see ViafirmaApiClient.ts's own comment on why
// it stopped embedding a provider's raw HTML/body there) - Fastify's DEFAULT
// error handler would still just serialize {statusCode, error: "Internal
// Server Error", message}, giving Ohnix nothing to tell "a technical
// provider hiccup" apart from any other 500 without string-matching the
// message. `error` here is the one deliberately machine-readable field
// (mirrors Ohnix's own ApiError.code convention) - Ohnix's
// viafirmaProvisioning.service.js keys off it to show a translated message
// instead of this English fallback verbatim, in whatever language the user
// has Ohnix set to.
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof CertificateProviderTechnicalError) {
    return reply.code(502).send({
      statusCode: 502,
      error: "certificate_provider_technical_error",
      provider: error.provider,
      message: error.message,
    });
  }
  return reply.send(error);
});

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

reconcileOrphanedProcessingDocuments(app.log).catch((err) => app.log.error(err, "Failed to reconcile orphaned PROCESSING documents"));

startContingencyRetryScheduler(app.log);
startFirmaPassIssuanceScheduler(app.log);
startViafirmaIssuanceScheduler(app.log);

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
