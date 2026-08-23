import type { FastifyInstance } from "fastify";

import { CreateInvoiceBodySchema } from "./documents.schemas.js";
import { createInvoice, getInvoice } from "./invoice.service.js";

/**
 * Production invoice endpoints. Still gated by requireDevApiKey at
 * registration time in src/index.ts — real per-company API-key auth is a
 * separate, not-yet-implemented piece of work (see the fiscal audit's
 * backlog), not something this change touches.
 */
export async function registerInvoiceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/invoices", async (request, reply) => {
    const body = CreateInvoiceBodySchema.parse(request.body);

    try {
      const invoice = await createInvoice(body);
      return await reply.code(201).send(invoice);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { companyId: string } }>(
    "/api/v1/documents/invoices/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { companyId } = request.query;
      if (!companyId) {
        return reply.code(400).send({ error: "companyId query parameter is required" });
      }

      const invoice = await getInvoice(companyId, id);
      if (!invoice) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send(invoice);
    },
  );
}
