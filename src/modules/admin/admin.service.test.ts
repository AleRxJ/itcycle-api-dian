import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A plain `process.env.X ??= ...` here doesn't reliably beat env.ts's own
// module-eval-time read (ESM hoists this file's imports - including the
// transitive import of env.js - ahead of its own top-level statements,
// regardless of source order) - vi.mock is the one mechanism guaranteed to
// run before env.js is evaluated.
vi.mock("../../shared/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/env.js")>();
  return { ...actual, env: { ...actual.env, firmaPassAllianceLoginKey: "test-alliance-login-key" } };
});

import { prisma } from "../../infrastructure/prisma.js";
import { hashApiKey } from "../../shared/apiKeyAuth.js";
import {
  createApiKeyForCompany,
  createCompany,
  createNumberingResolution,
  getFirmaPassStatus,
  listTestSubmissions,
  setDianConfiguration,
  updateNumberingResolution,
  uploadCertificate,
} from "./admin.service.js";

const TEST_NIT = "999000007";
const TEST_DV = "1";

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
  await prisma.creditNote.deleteMany({ where: { companyId: company.id } });
  await prisma.debitNote.deleteMany({ where: { companyId: company.id } });
  await prisma.supportDocument.deleteMany({ where: { companyId: company.id } });
  await prisma.invoice.deleteMany({ where: { companyId: company.id } });
  await prisma.apiKey.deleteMany({ where: { companyId: company.id } });
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.numberingResolution.deleteMany({ where: { companyId: company.id } });
  await prisma.dianConfiguration.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("admin provisioning", () => {
  it("createCompany is idempotent by (nit, dv)", async () => {
    const first = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });
    const second = await createCompany({ name: "Admin Test Co (renamed attempt)", nit: TEST_NIT, dv: TEST_DV, personType: "1" });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Admin Test Co"); // unchanged — createCompany returns the existing row, doesn't overwrite it
  });

  it("setDianConfiguration upserts (create then update)", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });

    const created = await setDianConfiguration({
      companyId: company.id,
      environment: "SANDBOX",
      softwareId: "sw-1",
      softwarePin: "pin-1",
      supplierProfile: { name: "Admin Test Co" },
    });
    expect(created.softwareId).toBe("sw-1");

    const updated = await setDianConfiguration({
      companyId: company.id,
      environment: "SANDBOX",
      softwareId: "sw-2",
      softwarePin: "pin-2",
      supplierProfile: { name: "Admin Test Co" },
    });
    expect(updated.id).toBe(created.id);
    expect(updated.softwareId).toBe("sw-2");
  });

  it("createNumberingResolution seeds currentNumber from startNumber", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });

    const numbering = await createNumberingResolution({
      companyId: company.id,
      documentType: "01",
      prefix: "ADMT",
      resolutionNumber: "123",
      startNumber: 500,
      endNumber: 999,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
    });

    expect(numbering.currentNumber).toBe(500);
  });

  it("updateNumberingResolution corrects an unused resolution's fields", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });
    const numbering = await createNumberingResolution({
      companyId: company.id,
      documentType: "91",
      prefix: "WRONG",
      resolutionNumber: "0",
      startNumber: 1,
      endNumber: 100,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
    });

    const updated = await updateNumberingResolution({
      companyId: company.id,
      resolutionId: numbering.id,
      prefix: "NC",
      startNumber: 1,
      endNumber: 999999,
    });

    expect(updated.prefix).toBe("NC");
    expect(updated.endNumber).toBe(999999);
    expect(updated.documentType).toBe("91"); // never changes
  });

  it("updateNumberingResolution rejects a resolution that already has documents issued against it", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });
    const numbering = await createNumberingResolution({
      companyId: company.id,
      documentType: "92",
      prefix: "USED",
      resolutionNumber: "0",
      startNumber: 1,
      endNumber: 100,
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
    });
    await prisma.numberingResolution.update({ where: { id: numbering.id }, data: { currentNumber: 2 } });

    await expect(
      updateNumberingResolution({ companyId: company.id, resolutionId: numbering.id, prefix: "NEW" }),
    ).rejects.toThrow(/already has documents issued/);
  });

  it("uploadCertificate stores the secret through the certificate store and never returns it", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });

    const result = await uploadCertificate({
      companyId: company.id,
      provider: "test",
      certificateIdentifier: "cert-123",
      p12Base64: Buffer.from("fake p12 bytes").toString("base64"),
      password: "super-secret-password",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
    });

    expect(result).not.toHaveProperty("p12Base64");
    expect(result).not.toHaveProperty("password");
    expect(JSON.stringify(result)).not.toContain("super-secret-password");

    const stored = await prisma.certificate.findUniqueOrThrow({ where: { id: result.id } });
    expect(stored.certificateIdentifier).toBe("cert-123");
  });

  it("getFirmaPassStatus reports loginKeySet from the shared alliance config and lists only firmapass-provider certificates", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });

    // loginKeySet reflects env.FIRMAPASS_ALLIANCE_LOGIN_KEY (set once above,
    // for every company) - not a per-company column anymore.
    const beforeKey = await getFirmaPassStatus(company.id);
    expect(beforeKey.loginKeySet).toBe(true);
    expect(beforeKey.certificates).toEqual([]);

    await prisma.certificate.create({
      data: {
        companyId: company.id,
        provider: "firmapass",
        certificateIdentifier: "status-test-cert",
        secretReference: "status-test-secret",
        expiresAt: null,
        status: "INACTIVE",
      },
    });
    await uploadCertificate({
      companyId: company.id,
      provider: "test", // non-firmapass — must NOT show up in the FirmaPass status list
      certificateIdentifier: "other-provider-cert",
      p12Base64: Buffer.from("fake").toString("base64"),
      password: "pw",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
    });

    const afterKey = await getFirmaPassStatus(company.id);
    expect(afterKey.loginKeySet).toBe(true);
    expect(afterKey.certificates).toHaveLength(1);
    expect(afterKey.certificates[0].certificateIdentifier).toBe("status-test-cert");
    expect(afterKey.certificates[0].status).toBe("INACTIVE");
    expect(afterKey.certificates[0].expiresAt).toBeNull();
  });

  it("createApiKeyForCompany returns a raw key whose hash matches what's persisted", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });

    const { rawKey } = await createApiKeyForCompany({ companyId: company.id, label: "admin-test" });

    const stored = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(rawKey) } });
    expect(stored?.companyId).toBe(company.id);
    expect(stored?.label).toBe("admin-test");
  });

  it("listTestSubmissions filters by testSetId and omits documents sent outside habilitación", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });

    const roundOne = await prisma.invoice.create({
      data: { companyId: company.id, internalReference: "test-round-1", testSetId: "round-1", status: "ACCEPTED", invoiceNumber: "SETP1" },
    });
    const roundTwo = await prisma.supportDocument.create({
      data: { companyId: company.id, internalReference: "test-round-2", testSetId: "round-2", status: "ERROR" },
    });
    await prisma.invoice.create({
      data: { companyId: company.id, internalReference: "prod-1", testSetId: null, status: "ACCEPTED", invoiceNumber: "PROD1" },
    });

    const roundOneOnly = await listTestSubmissions(company.id, "round-1");
    expect(roundOneOnly).toHaveLength(1);
    expect(roundOneOnly[0].id).toBe(roundOne.id);
    expect(roundOneOnly[0].documentType).toBe("01");

    const everyTestSubmission = await listTestSubmissions(company.id);
    const ids = everyTestSubmission.map((s) => s.id);
    expect(ids).toContain(roundOne.id);
    expect(ids).toContain(roundTwo.id);
    expect(ids).toHaveLength(2); // the null-testSetId production invoice must not show up here
  });
});
