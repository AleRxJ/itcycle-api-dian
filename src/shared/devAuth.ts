import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "./env.js";

/**
 * Minimal shared-secret guard for dev-only routes (e.g. /api/v1/dian/test-invoice).
 * Not the real auth/API-key system planned for the public API (section 20) —
 * just enough to keep this endpoint from being open to the internet.
 */
export async function requireDevApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!env.devApiKey) {
    reply.code(503).send({ error: "DEV_API_KEY is not configured" });
    return;
  }

  if (request.headers["x-api-key"] !== env.devApiKey) {
    reply.code(401).send({ error: "unauthorized" });
  }
}
