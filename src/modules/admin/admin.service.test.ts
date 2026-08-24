import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../../infrastructure/prisma.js";
import { hashApiKey } from "../../shared/apiKeyAuth.js";
import {
  createApiKeyForCompany,
  createCompany,
  createNumberingResolution,
  getFirmaPassStatus,
  setDianConfiguration,
  uploadCertificate,
} from "./admin.service.js";

const TEST_NIT = "999000007";
const TEST_DV = "1";

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
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

  it("getFirmaPassStatus reports loginKeySet and lists only firmapass-provider certificates", async () => {
    const company = await createCompany({ name: "Admin Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });

    const beforeKey = await getFirmaPassStatus(company.id);
    expect(beforeKey.loginKeySet).toBe(false);
    expect(beforeKey.certificates).toEqual([]);

    await prisma.company.update({ where: { id: company.id }, data: { firmaPassLoginKeyCiphertext: "fake-ciphertext" } });
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
});
