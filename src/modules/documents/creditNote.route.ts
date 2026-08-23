import type { FastifyInstance } from "fastify";

import { createCreditNote, getCreditNote, retryCreditNoteSend } from "./creditNote.service.js";
import { CreateNoteBodySchema, RetrySendBodySchema } from "./documents.schemas.js";

/** Production credit-note endpoints — see invoice.route.ts for the auth note. */
export async function registerCreditNoteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/credit-notes", async (request, reply) => {
    const body = CreateNoteBodySchema.parse(request.body);

    try {
      const creditNote = await createCreditNote({ ...body, companyId: request.company!.id });
      return await reply.code(201).send(creditNote);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/credit-notes/:id", async (request, reply) => {
    const creditNote = await getCreditNote(request.company!.id, request.params.id);
    if (!creditNote) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(creditNote);
  });

  app.post<{ Params: { id: string } }>("/api/v1/documents/credit-notes/:id/retry-send", async (request, reply) => {
    const body = RetrySendBodySchema.parse(request.body ?? {});

    try {
      const creditNote = await retryCreditNoteSend(request.company!.id, request.params.id, body.send);
      return await reply.send(creditNote);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
