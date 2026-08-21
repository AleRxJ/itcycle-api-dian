import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createTestInvoice } from "./test-invoice.service.js";

const TestInvoiceBodySchema = z.object({
  companyId: z.string(),
  internalReference: z.string(),
  invoice: z.record(z.string(), z.unknown()),
  send: z
    .object({
      method: z.enum(["SendBillSync", "SendBillAsync", "SendTestSetAsync"]).optional(),
      testSetId: z.string().optional(),
    })
    .optional(),
});

/**
 * POST /api/v1/dian/test-invoice — dev-only. Builds, signs, and sends an
 * invoice for an already-provisioned test company (Company +
 * DianConfiguration + NumberingResolution + Certificate rows must already
 * exist — see docs/dian/sandbox-tests.md). Protected by requireDevApiKey,
 * registered by the caller.
 */
export async function registerTestInvoiceRoute(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/dian/test-invoice", async (request, reply) => {
    const body = TestInvoiceBodySchema.parse(request.body);

    try {
      const invoice = await createTestInvoice(body);
      return await reply.code(201).send(invoice);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
