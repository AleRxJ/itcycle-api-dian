import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import { createTestInvoice } from "./test-invoice.service.js";

// Exercises idempotency, status transitions, and error handling against the
// real dev database, but never against dian-kit or DIAN itself — a fake
// DianProvider and CertificateSecretStore are injected instead. This is the
// payoff of the DianProvider abstraction: it's swappable for a test double.

const TEST_NIT = "999000001";
const TEST_DV = "1";

const fakeSecretStore: CertificateSecretStore = {
  save: vi.fn(),
  get: vi.fn().mockResolvedValue({ p12: Buffer.from("fake"), password: "fake" }),
  delete: vi.fn(),
};

function fakeProvider(overrides: Partial<DianProvider> = {}): DianProvider {
  return {
    createInvoice: vi.fn(),
    createCreditNote: vi.fn(),
    createDebitNote: vi.fn(),
    createSupportDocument: vi.fn(),
    send: vi.fn(),
    getStatus: vi.fn(),
    getStatusZip: vi.fn(),
    getNumberingRange: vi.fn(),
    lookupBuyer: vi.fn(),
    ...overrides,
  };
}

function invoiceInput(id: string) {
  return {
    id,
    issueDate: new Date().toISOString(),
    issueTime: new Date().toISOString(),
    customer: {},
    lines: [],
    taxTotals: [],
    legalMonetaryTotal: {},
    paymentMeans: {},
  };
}

let companyId: string;

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
  await prisma.invoice.deleteMany({ where: { companyId: company.id } });
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.numberingResolution.deleteMany({ where: { companyId: company.id } });
  await prisma.dianConfiguration.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(async () => {
  await cleanup();

  const company = await prisma.company.create({
    data: { name: "Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;

  await prisma.dianConfiguration.create({
    data: {
      companyId,
      environment: "SANDBOX",
      softwareId: "sw-id",
      softwarePin: "sw-pin",
      technicalKey: "tech-key",
      supplierProfile: { name: "Test Co" },
    },
  });
  await prisma.numberingResolution.create({
    data: {
      companyId,
      prefix: "TST",
      resolutionNumber: "123",
      startNumber: 1,
      endNumber: 1000,
      currentNumber: 1,
      startDate: new Date(),
      endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    },
  });
  await prisma.certificate.create({
    data: {
      companyId,
      provider: "test",
      certificateIdentifier: "test-cert",
      secretReference: "test-secret",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createTestInvoice", () => {
  it("accepts an invoice when DIAN validates it", async () => {
    const createInvoice = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-accepted", documentNumber: "TST01" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });

    const result = await createTestInvoice(
      { companyId, internalReference: "ref-accepted", invoice: invoiceInput("TST01") },
      { secretStore: fakeSecretStore, createProvider: () => fakeProvider({ createInvoice, send }) },
    );

    expect(result.status).toBe("ACCEPTED");
    expect(result.cufe).toBe("cufe-accepted");
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects an invoice when DIAN reports validation errors", async () => {
    const send = vi.fn().mockResolvedValue({
      isValid: false,
      statusCode: "99",
      statusDescription: "rejected",
      errors: [{ code: "FAD06", description: "boom" }],
      rawResponse: "",
    });
    const createInvoice = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-rejected", documentNumber: "TST02" });

    const result = await createTestInvoice(
      { companyId, internalReference: "ref-rejected", invoice: invoiceInput("TST02") },
      { secretStore: fakeSecretStore, createProvider: () => fakeProvider({ createInvoice, send }) },
    );

    expect(result.status).toBe("REJECTED");
    expect(result.errorMessage).toContain("boom");
  });

  it("marks the invoice ERROR and rethrows when the provider fails", async () => {
    const createInvoice = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      createTestInvoice(
        { companyId, internalReference: "ref-error", invoice: invoiceInput("TST03") },
        { secretStore: fakeSecretStore, createProvider: () => fakeProvider({ createInvoice }) },
      ),
    ).rejects.toThrow("network down");

    const invoice = await prisma.invoice.findUnique({
      where: { companyId_internalReference: { companyId, internalReference: "ref-error" } },
    });
    expect(invoice?.status).toBe("ERROR");
    expect(invoice?.errorMessage).toBe("network down");
  });

  it("is idempotent: replaying the same internalReference never calls the provider twice", async () => {
    const createInvoice = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-idempotent", documentNumber: "TST04" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const deps = { secretStore: fakeSecretStore, createProvider: () => fakeProvider({ createInvoice, send }) };

    const first = await createTestInvoice(
      { companyId, internalReference: "ref-idempotent", invoice: invoiceInput("TST04") },
      deps,
    );
    const second = await createTestInvoice(
      { companyId, internalReference: "ref-idempotent", invoice: invoiceInput("TST04") },
      deps,
    );

    expect(second.id).toBe(first.id);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
