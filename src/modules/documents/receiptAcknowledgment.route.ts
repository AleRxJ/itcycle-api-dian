import type { FastifyInstance } from "fastify";

import { CreateReceiptAcknowledgmentBodySchema } from "./documents.schemas.js";
import { createReceiptAcknowledgment, getReceiptAcknowledgment } from "./receiptAcknowledgment.service.js";

/**
 * Phase 1 / SIMULATION ONLY RADIAN buyer-acknowledgment endpoints - see
 * receiptAcknowledgment.service.ts#assertSimulationOnly. Gated by
 * requireApiKey (registered in src/index.ts), same as every other document
 * route - companyId always comes from request.company, never the body.
 */
export async function registerReceiptAcknowledgmentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/receipt-acknowledgments", async (request, reply) => {
    const body = CreateReceiptAcknowledgmentBodySchema.parse(request.body);

    try {
      const receipt = await createReceiptAcknowledgment({ ...body, companyId: request.company!.id });
      return await reply.code(201).send(receipt);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "receipt_acknowledgment_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/receipt-acknowledgments/:id", async (request, reply) => {
    const receipt = await getReceiptAcknowledgment(request.company!.id, request.params.id);
    if (!receipt) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(receipt);
  });
}
