import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../infrastructure/prisma.js";
import { generateApiKey, hashApiKey, requireApiKey } from "./apiKeyAuth.js";

const TEST_NIT = "999000005";
const TEST_DV = "1";

function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
  return { headers, log: { warn: vi.fn() } } as unknown as FastifyRequest;
}

function fakeReply() {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as FastifyReply & { code: typeof reply.code; send: typeof reply.send };
}

let companyId: string;
let activeRawKey: string;
let inactiveRawKey: string;

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
  await prisma.apiKey.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(async () => {
  await cleanup();

  const company = await prisma.company.create({
    data: { name: "Test Co Api Keys", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;

  const active = generateApiKey();
  activeRawKey = active.rawKey;
  await prisma.apiKey.create({
    data: { companyId, keyHash: active.keyHash, keyPrefix: active.keyPrefix, label: "active" },
  });

  const inactive = generateApiKey();
  inactiveRawKey = inactive.rawKey;
  await prisma.apiKey.create({
    data: { companyId, keyHash: inactive.keyHash, keyPrefix: inactive.keyPrefix, label: "inactive", status: "INACTIVE" },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("hashApiKey / generateApiKey", () => {
  it("hashes deterministically and never returns the raw key twice", () => {
    const { rawKey, keyHash } = generateApiKey();
    expect(hashApiKey(rawKey)).toBe(keyHash);
    expect(generateApiKey().rawKey).not.toBe(rawKey);
  });
});

describe("requireApiKey", () => {
  it("rejects a request with no x-api-key header", async () => {
    const request = fakeRequest();
    const reply = fakeReply();

    await requireApiKey(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(request.company).toBeUndefined();
  });

  it("rejects an unknown key", async () => {
    const request = fakeRequest({ "x-api-key": "not-a-real-key" });
    const reply = fakeReply();

    await requireApiKey(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(request.company).toBeUndefined();
  });

  it("rejects an inactive key", async () => {
    const request = fakeRequest({ "x-api-key": inactiveRawKey });
    const reply = fakeReply();

    await requireApiKey(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(request.company).toBeUndefined();
  });

  it("attaches the owning company for a valid, active key", async () => {
    const request = fakeRequest({ "x-api-key": activeRawKey });
    const reply = fakeReply();

    await requireApiKey(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(request.company?.id).toBe(companyId);
    expect(request.company?.nit).toBe(TEST_NIT);
  });
});
