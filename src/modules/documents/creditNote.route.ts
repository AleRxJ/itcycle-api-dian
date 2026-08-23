import type { FastifyInstance } from "fastify";

import { createCreditNote, getCreditNote } from "./creditNote.service.js";
import { CreateNoteBodySchema } from "./documents.schemas.js";

/** Production credit-note endpoints — see invoice.route.ts for the auth note. */
export async function registerCreditNoteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/credit-notes", async (request, reply) => {
    const body = CreateNoteBodySchema.parse(request.body);

    try {
      const creditNote = await createCreditNote(body);
      return await reply.code(201).send(creditNote);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { companyId: string } }>(
    "/api/v1/documents/credit-notes/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { companyId } = request.query;
      if (!companyId) {
        return reply.code(400).send({ error: "companyId query parameter is required" });
      }

      const creditNote = await getCreditNote(companyId, id);
      if (!creditNote) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send(creditNote);
    },
  );
}
