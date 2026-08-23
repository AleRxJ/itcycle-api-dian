import type { FastifyInstance } from "fastify";

import { createDebitNote, getDebitNote, retryDebitNoteSend } from "./debitNote.service.js";
import { CreateNoteBodySchema, RetrySendBodySchema } from "./documents.schemas.js";

/** Production debit-note endpoints — see invoice.route.ts for the auth note. */
export async function registerDebitNoteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/debit-notes", async (request, reply) => {
    const body = CreateNoteBodySchema.parse(request.body);

    try {
      const debitNote = await createDebitNote({ ...body, companyId: request.company!.id });
      return await reply.code(201).send(debitNote);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/debit-notes/:id", async (request, reply) => {
    const debitNote = await getDebitNote(request.company!.id, request.params.id);
    if (!debitNote) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(debitNote);
  });

  app.post<{ Params: { id: string } }>("/api/v1/documents/debit-notes/:id/retry-send", async (request, reply) => {
    const body = RetrySendBodySchema.parse(request.body ?? {});

    try {
      const debitNote = await retryDebitNoteSend(request.company!.id, request.params.id, body.send);
      return await reply.send(debitNote);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
