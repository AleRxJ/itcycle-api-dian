import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import { createDebitNote } from "./debitNote.service.js";

const TEST_NIT = "999000004";
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
    send: vi.fn(),
    getStatus: vi.fn(),
    getStatusZip: vi.fn(),
    getNumberingRange: vi.fn(),
    lookupBuyer: vi.fn(),
    ...overrides,
  };
}

function noteDocument() {
  return {
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
let acceptedInvoiceId: string;
let pendingInvoiceId: string;
let numberingId: string;

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
  await prisma.debitNote.deleteMany({ where: { companyId: company.id } });
  await prisma.invoice.deleteMany({ where: { companyId: company.id } });
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.numberingResolution.deleteMany({ where: { companyId: company.id } });
  await prisma.dianConfiguration.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(async () => {
  await cleanup();

  const company = await prisma.company.create({
    data: { name: "Test Co Debit Notes", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;

  await prisma.dianConfiguration.create({
    data: {
      companyId,
      environment: "SANDBOX",
      softwareId: "sw-id",
      softwarePin: "sw-pin",
      technicalKey: "tech-key",
      supplierProfile: { name: "Test Co Debit Notes" },
    },
  });

  const invoiceNumbering = await prisma.numberingResolution.create({
    data: {
      companyId,
      documentType: "01",
      prefix: "TSTI",
      resolutionNumber: "123",
      startNumber: 1,
      endNumber: 1000,
      currentNumber: 5,
      startDate: new Date(),
      endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    },
  });
  const debitNoteNumbering = await prisma.numberingResolution.create({
    data: {
      companyId,
      documentType: "92",
      prefix: "TSTND",
      resolutionNumber: "789",
      startNumber: 1,
      endNumber: 1000,
      currentNumber: 1,
      startDate: new Date(),
      endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    },
  });
  numberingId = debitNoteNumbering.id;

  await prisma.certificate.create({
    data: {
      companyId,
      provider: "test",
      certificateIdentifier: "test-cert",
      secretReference: "test-secret",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    },
  });

  const acceptedInvoice = await prisma.invoice.create({
    data: {
      companyId,
      numberingId: invoiceNumbering.id,
      internalReference: "invoice-accepted",
      invoiceNumber: "TSTI4",
      cufe: "cufe-original-invoice",
      status: "ACCEPTED",
      issuedAt: new Date(),
      acceptedAt: new Date(),
    },
  });
  acceptedInvoiceId = acceptedInvoice.id;

  const pendingInvoice = await prisma.invoice.create({
    data: {
      companyId,
      numberingId: invoiceNumbering.id,
      internalReference: "invoice-pending",
      status: "PROCESSING",
    },
  });
  pendingInvoiceId = pendingInvoice.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createDebitNote", () => {
  it("accepts a debit note and derives billingReference from the referenced invoice", async () => {
    const createDebitNoteMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-nd-1", documentNumber: "TSTND1" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });

    const result = await createDebitNote(
      {
        companyId,
        internalReference: "nd-ref-1",
        invoiceId: acceptedInvoiceId,
        document: noteDocument(),
        discrepancyResponse: { responseCode: "1", description: "Cobro de intereses por mora en pago" },
      },
      { secretStore: fakeSecretStore, createProvider: () => fakeProvider({ createDebitNote: createDebitNoteMock, send }) },
    );

    expect(result.status).toBe("ACCEPTED");
    expect(createDebitNoteMock).toHaveBeenCalledTimes(1);
    const [inputArg] = createDebitNoteMock.mock.calls[0] as [
      { id: string; billingReference: { id: string; uuid: string }; discrepancyResponse: { referenceId: string } },
    ];
    expect(inputArg.id).toBe("TSTND1");
    expect(inputArg.billingReference.id).toBe("TSTI4");
    expect(inputArg.billingReference.uuid).toBe("cufe-original-invoice");
    expect(inputArg.discrepancyResponse.referenceId).toBe("TSTI4");
  });

  it("refuses to issue a debit note against a non-ACCEPTED invoice", async () => {
    await expect(
      createDebitNote(
        {
          companyId,
          internalReference: "nd-ref-2",
          invoiceId: pendingInvoiceId,
          document: noteDocument(),
          discrepancyResponse: { responseCode: "1", description: "test" },
        },
        { secretStore: fakeSecretStore, createProvider: () => fakeProvider() },
      ),
    ).rejects.toThrow(/not ACCEPTED/);
  });

  it("marks the debit note ERROR and rethrows when the provider fails", async () => {
    const createDebitNoteMock = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      createDebitNote(
        {
          companyId,
          internalReference: "nd-ref-3",
          invoiceId: acceptedInvoiceId,
          document: noteDocument(),
          discrepancyResponse: { responseCode: "1", description: "test" },
        },
        { secretStore: fakeSecretStore, createProvider: () => fakeProvider({ createDebitNote: createDebitNoteMock }) },
      ),
    ).rejects.toThrow("network down");

    const debitNote = await prisma.debitNote.findUnique({
      where: { companyId_internalReference: { companyId, internalReference: "nd-ref-3" } },
    });
    expect(debitNote?.status).toBe("ERROR");
  });

  it("is idempotent: replaying the same internalReference never claims a second number", async () => {
    const createDebitNoteMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-nd-4", documentNumber: "TSTND4" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const deps = {
      secretStore: fakeSecretStore,
      createProvider: () => fakeProvider({ createDebitNote: createDebitNoteMock, send }),
    };
    const params = {
      companyId,
      internalReference: "nd-ref-4",
      invoiceId: acceptedInvoiceId,
      document: noteDocument(),
      discrepancyResponse: { responseCode: "1", description: "test" },
    };

    const first = await createDebitNote(params, deps);
    const numberingAfterFirst = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });

    const second = await createDebitNote(params, deps);
    const numberingAfterSecond = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });

    expect(second.id).toBe(first.id);
    expect(createDebitNoteMock).toHaveBeenCalledTimes(1);
    expect(numberingAfterSecond.currentNumber).toBe(numberingAfterFirst.currentNumber);
  });
});
