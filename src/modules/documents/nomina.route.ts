import type { FastifyInstance } from "fastify";

import { CreatePayrollAdjustmentBodySchema, CreatePayrollBodySchema, RetrySendBodySchema } from "./documents.schemas.js";
import {
  createPayrollAdjustment,
  createPayrollDocument,
  getPayrollAdjustment,
  getPayrollDocument,
  retryPayrollDocumentSend,
} from "./nomina.service.js";

/**
 * Production Nómina Electrónica endpoints - added alongside invoice.route.ts/
 * creditNote.route.ts/debitNote.route.ts/supportDocument.route.ts, same
 * requireApiKey gating (see invoice.route.ts's own auth note), registered
 * as its own sibling document family rather than nested under `/invoices`.
 */
export async function registerPayrollRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/payroll", async (request, reply) => {
    const body = CreatePayrollBodySchema.parse(request.body);

    try {
      const payroll = await createPayrollDocument({ ...body, companyId: request.company!.id });
      return await reply.code(201).send(payroll);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/payroll/:id", async (request, reply) => {
    const payroll = await getPayrollDocument(request.company!.id, request.params.id);
    if (!payroll) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(payroll);
  });

  app.post<{ Params: { id: string } }>("/api/v1/documents/payroll/:id/retry-send", async (request, reply) => {
    const body = RetrySendBodySchema.parse(request.body ?? {});

    try {
      const payroll = await retryPayrollDocumentSend(request.company!.id, request.params.id, body.send);
      return await reply.send(payroll);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/v1/documents/payroll-adjustments", async (request, reply) => {
    const body = CreatePayrollAdjustmentBodySchema.parse(request.body);

    try {
      const adjustment = await createPayrollAdjustment({ ...body, companyId: request.company!.id });
      return await reply.code(201).send(adjustment);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/payroll-adjustments/:id", async (request, reply) => {
    const adjustment = await getPayrollAdjustment(request.company!.id, request.params.id);
    if (!adjustment) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(adjustment);
  });
}
