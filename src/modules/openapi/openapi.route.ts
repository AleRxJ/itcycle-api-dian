import type { FastifyInstance } from "fastify";

import { openApiSpec } from "../../openapi/spec.js";

/**
 * Publishes the hand-authored, static OpenAPI 3.0.3 document for the
 * customer-facing document API (see src/openapi/spec.ts). Deliberately not
 * gated by requireApiKey/requireAdminApiKey — this is public documentation,
 * matching how competitors publish their own API docs (developers.factus.com.co,
 * developer.alegra.com). Serves a plain static object; it does not hook into
 * live request validation and cannot affect any other route's behavior.
 */
export async function registerOpenApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/openapi.json", async (_request, reply) => reply.send(openApiSpec));
}
