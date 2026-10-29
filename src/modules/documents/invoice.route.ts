import type { FastifyInstance } from "fastify";

import { CreateInvoiceBodySchema, RetrySendBodySchema } from "./documents.schemas.js";
import { createInvoice, getInvoice, getInvoiceAttachedDocument, getInvoiceSignedXml, retryInvoiceSend } from "./invoice.service.js";

/**
 * Production invoice endpoints. Gated by requireApiKey (registered in
 * src/index.ts) — companyId always comes from request.company, set by that
 * middleware from the authenticated ApiKey, never from the request body.
 */
export async function registerInvoiceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/invoices", async (request, reply) => {
    const body = CreateInvoiceBodySchema.parse(request.body);

    try {
      const invoice = await createInvoice({ ...body, companyId: request.company!.id });
      return await reply.code(201).send(invoice);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/invoices/:id", async (request, reply) => {
    const invoice = await getInvoice(request.company!.id, request.params.id);
    if (!invoice) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(invoice);
  });

  // The signed XML exactly as it went to DIAN (404 when the invoice isn't this
  // company's or was never signed). Scoped by the API key's company, like every
  // other route here.
  app.get<{ Params: { id: string } }>("/api/v1/documents/invoices/:id/xml", async (request, reply) => {
    const signed = await getInvoiceSignedXml(request.company!.id, request.params.id);
    if (!signed) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.type("application/xml").send(signed.xml);
  });

  // DIAN AttachedDocument for the buyer (signed XML + DIAN's ApplicationResponse).
  // 404 until the invoice is ACCEPTED with a stored DIAN answer.
  app.get<{ Params: { id: string } }>("/api/v1/documents/invoices/:id/attached-document", async (request, reply) => {
    const attached = await getInvoiceAttachedDocument(request.company!.id, request.params.id);
    if (!attached) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.type("application/xml").send(attached.xml);
  });

  app.post<{ Params: { id: string } }>("/api/v1/documents/invoices/:id/retry-send", async (request, reply) => {
    const body = RetrySendBodySchema.parse(request.body ?? {});

    try {
      const invoice = await retryInvoiceSend(request.company!.id, request.params.id, body.send);
      return await reply.send(invoice);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
