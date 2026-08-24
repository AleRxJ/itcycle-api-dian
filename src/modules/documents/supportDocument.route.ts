import type { FastifyInstance } from "fastify";

import { CreateSupportDocumentBodySchema, RetrySendBodySchema } from "./documents.schemas.js";
import { createSupportDocument, getSupportDocument, retrySupportDocumentSend } from "./supportDocument.service.js";

/**
 * Production Documento Soporte endpoints. Gated by requireApiKey (registered
 * in src/index.ts) — companyId always comes from request.company, set by
 * that middleware from the authenticated ApiKey, never from the request body.
 */
export async function registerSupportDocumentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/documents/support-documents", async (request, reply) => {
    const body = CreateSupportDocumentBodySchema.parse(request.body);

    try {
      const supportDocument = await createSupportDocument({ ...body, companyId: request.company!.id });
      return await reply.code(201).send(supportDocument);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: "dian_send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/documents/support-documents/:id", async (request, reply) => {
    const supportDocument = await getSupportDocument(request.company!.id, request.params.id);
    if (!supportDocument) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send(supportDocument);
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/documents/support-documents/:id/retry-send",
    async (request, reply) => {
      const body = RetrySendBodySchema.parse(request.body ?? {});

      try {
        const supportDocument = await retrySupportDocumentSend(request.company!.id, request.params.id, body.send);
        return await reply.send(supportDocument);
      } catch (error) {
        request.log.error(error);
        return reply.code(502).send({
          error: "dian_send_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
