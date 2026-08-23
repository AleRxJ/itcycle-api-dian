import { createHash, randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { prisma } from "../infrastructure/prisma.js";

/** How many raw-key characters are kept as `keyPrefix` — enough to identify a key in logs/UI, never enough to reconstruct it. */
const PREFIX_LENGTH = 8;

export interface GeneratedApiKey {
  /** Shown to the caller exactly once — never persisted. */
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
}

/** SHA-256 hex digest — appropriate for a high-entropy random token, not a human-chosen password. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Generates a new 32-byte random API key plus everything needed to persist it (the raw value is never returned again after this). */
export function generateApiKey(): GeneratedApiKey {
  const rawKey = randomBytes(32).toString("base64url");
  return { rawKey, keyHash: hashApiKey(rawKey), keyPrefix: rawKey.slice(0, PREFIX_LENGTH) };
}

declare module "fastify" {
  interface FastifyRequest {
    company?: { id: string; nit: string; dv: string; name: string };
  }
}

/**
 * Production auth for /api/v1/documents/*: looks up the `x-api-key` header
 * against ApiKey.keyHash and attaches the owning Company to the request.
 * Route handlers must read `request.company.id` for companyId — never trust
 * a client-supplied companyId, since that was exactly the gap this replaces
 * (see docs/dian/sandbox-tests.md and the fiscal audit's backlog).
 *
 * Not used by /api/v1/dian/test-invoice — that dev-only route keeps
 * requireDevApiKey (see devAuth.ts) and a caller-supplied companyId.
 */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawKey = request.headers["x-api-key"];
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    reply.code(401).send({ error: "unauthorized", message: "Missing x-api-key header" });
    return;
  }

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(rawKey) },
    include: { company: true },
  });

  if (!apiKey || apiKey.status !== "ACTIVE" || apiKey.company.status !== "ACTIVE") {
    reply.code(401).send({ error: "unauthorized", message: "Invalid or inactive API key" });
    return;
  }

  request.company = {
    id: apiKey.company.id,
    nit: apiKey.company.nit,
    dv: apiKey.company.dv,
    name: apiKey.company.name,
  };

  // Best-effort — never delay or fail the request over a lastUsedAt write.
  void prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch((error) => {
    request.log.warn({ error }, "failed to update ApiKey.lastUsedAt");
  });
}
