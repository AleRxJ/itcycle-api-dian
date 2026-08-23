import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "./env.js";

/**
 * Shared-secret guard for /api/v1/admin/* (tenant provisioning). Distinct
 * from requireDevApiKey (dev-only manual testing) and requireApiKey
 * (per-company, customer-facing document issuance): these routes create the
 * Company/DianConfiguration/NumberingResolution/Certificate/ApiKey rows a
 * per-company key would need to even exist, so they can't be gated by one.
 * Meant to be called only by Ohnix's own backend (see
 * Backend/services/itcycleDian.service.js), never exposed to a customer.
 */
export async function requireAdminApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!env.adminApiKey) {
    reply.code(503).send({ error: "ADMIN_API_KEY is not configured" });
    return;
  }

  if (request.headers["x-admin-api-key"] !== env.adminApiKey) {
    reply.code(401).send({ error: "unauthorized" });
  }
}
