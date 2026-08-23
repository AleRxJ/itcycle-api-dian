import type { FastifyInstance } from "fastify";

import { createDebitNote, getDebitNote } from "./debitNote.service.js";
import { CreateNoteBodySchema } from "./documents.schemas.js";

/** Production debit-note endpoints — see invoice.route.ts for the auth note. */
export async function registerDebitNoteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/debit-notes", async (request, reply) => {
    const body = CreateNoteBodySchema.parse(request.body);

    try {
      const debitNote = await createDebitNote(body);
      return await reply.code(201).send(debitNote);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { companyId: string } }>(
    "/api/v1/documents/debit-notes/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { companyId } = request.query;
      if (!companyId) {
        return reply.code(400).send({ error: "companyId query parameter is required" });
      }

      const debitNote = await getDebitNote(companyId, id);
      if (!debitNote) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send(debitNote);
    },
  );
}
