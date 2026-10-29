import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same setup as viafirmaIssuance.service.test.ts: env mocked before env.js
// loads, and only the provider class mocked so no call reaches Viafirma.
vi.mock("../shared/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/env.js")>();
  return {
    ...actual,
    env: { ...actual.env, viafirmaConsumerKey: "test-key", viafirmaConsumerSecret: "test-secret", viafirmaRa: "viafirmaco" },
  };
});

const mockGetRequestStatus = vi.fn();

vi.mock("../providers/certificates/ViafirmaCertificateProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/certificates/ViafirmaCertificateProvider.js")>();
  return {
    ...actual,
    ViafirmaCertificateProvider: vi.fn().mockImplementation(() => ({
      getRequestStatus: mockGetRequestStatus,
    })),
  };
});

import { randomUUID } from "node:crypto";
import { prisma } from "../infrastructure/prisma.js";
import { createCompany } from "../modules/admin/admin.service.js";
import { createDefaultCertificateSecretStore } from "../shared/certificateStore.js";
import { finalizePendingViafirmaCertificates } from "./viafirmaIssuance.job.js";

const TEST_NIT = "999000017";
const TEST_DV = "1";

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

// An open request as createViafirmaRequest leaves it: INACTIVE, no expiry,
// bare private key in the store.
async function openRequest(codRequest: string) {
  const company =
    (await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } }))
    ?? (await createCompany({ name: "Viafirma Job Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" }));
  const secretReference = randomUUID();
  await createDefaultCertificateSecretStore().save(secretReference, { p12: Buffer.from("PRIVATE KEY"), password: "" });
  return prisma.certificate.create({
    data: {
      companyId: company.id,
      provider: "viafirma",
      certificateIdentifier: codRequest,
      secretReference,
      expiresAt: null,
      status: "INACTIVE",
      providerMetadata: { publicId: `PUB-${codRequest}` },
    },
  });
}

beforeAll(cleanup);
beforeEach(async () => {
  vi.clearAllMocks();
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("finalizePendingViafirmaCertificates", () => {
  it("keeps a rues_error request and its private key: Viafirma can still fix it and move it on", async () => {
    const row = await openRequest("REQ-RUES");
    mockGetRequestStatus.mockResolvedValue("rues_error");

    const summary = await finalizePendingViafirmaCertificates();

    expect(summary).toMatchObject({ stillPending: 1, failed: 0 });
    expect(await prisma.certificate.count({ where: { id: row.id } })).toBe(1);
    expect((await createDefaultCertificateSecretStore().get(row.secretReference)).p12.toString()).toBe("PRIVATE KEY");
  });

  it("still discards a request Viafirma rejected for good", async () => {
    const row = await openRequest("REQ-REJECTED");
    mockGetRequestStatus.mockResolvedValue("accreditation_rejected");

    const summary = await finalizePendingViafirmaCertificates();

    expect(summary).toMatchObject({ failed: 1 });
    expect(await prisma.certificate.count({ where: { id: row.id } })).toBe(0);
    await expect(createDefaultCertificateSecretStore().get(row.secretReference)).rejects.toThrow();
  });
});
