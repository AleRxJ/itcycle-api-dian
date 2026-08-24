import { DianTransportError } from "@dian-kit/sdk-node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import type { DocumentXmlStore } from "../../providers/documents/DocumentXmlStore.js";
import { createCreditNote, retryCreditNoteSend } from "./creditNote.service.js";

function fakeXmlStore(): DocumentXmlStore {
  const files = new Map<string, string>();
  return {
    save: vi.fn(async (ref: string, xml: string) => {
      files.set(ref, xml);
    }),
    get: vi.fn(async (ref: string) => {
      const xml = files.get(ref);
      if (xml === undefined) throw new Error(`no xml stored for ${ref}`);
      return xml;
    }),
    delete: vi.fn(async (ref: string) => {
      files.delete(ref);
    }),
  };
}

const TEST_NIT = "999000003";
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
  await prisma.creditNote.deleteMany({ where: { companyId: company.id } });
  await prisma.invoice.deleteMany({ where: { companyId: company.id } });
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.numberingResolution.deleteMany({ where: { companyId: company.id } });
  await prisma.dianConfiguration.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(async () => {
  await cleanup();

  const company = await prisma.company.create({
    data: { name: "Test Co Credit Notes", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;

  await prisma.dianConfiguration.create({
    data: {
      companyId,
      environment: "SANDBOX",
      softwareId: "sw-id",
      softwarePin: "sw-pin",
      technicalKey: "tech-key",
      supplierProfile: { name: "Test Co Credit Notes" },
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
  const creditNoteNumbering = await prisma.numberingResolution.create({
    data: {
      companyId,
      documentType: "91",
      prefix: "TSTNC",
      resolutionNumber: "456",
      startNumber: 1,
      endNumber: 1000,
      currentNumber: 1,
      startDate: new Date(),
      endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    },
  });
  numberingId = creditNoteNumbering.id;

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

describe("createCreditNote", () => {
  it("accepts a credit note and derives billingReference from the referenced invoice", async () => {
    const createCreditNoteMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-nc-1", documentNumber: "TSTNC1" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });

    const result = await createCreditNote(
      {
        companyId,
        internalReference: "nc-ref-1",
        invoiceId: acceptedInvoiceId,
        document: noteDocument(),
        discrepancyResponse: { responseCode: "2", description: "Anulacion por error en datos del cliente" },
      },
      {
        secretStore: fakeSecretStore,
        xmlStore: fakeXmlStore(),
        createProvider: () => fakeProvider({ createCreditNote: createCreditNoteMock, send }),
      },
    );

    expect(result.status).toBe("ACCEPTED");
    expect(createCreditNoteMock).toHaveBeenCalledTimes(1);
    const [inputArg] = createCreditNoteMock.mock.calls[0] as [
      { id: string; billingReference: { id: string; uuid: string }; discrepancyResponse: { referenceId: string } },
    ];
    expect(inputArg.id).toBe("TSTNC1");
    expect(inputArg.billingReference.id).toBe("TSTI4");
    expect(inputArg.billingReference.uuid).toBe("cufe-original-invoice");
    expect(inputArg.discrepancyResponse.referenceId).toBe("TSTI4");
  });

  it("refuses to issue a credit note against a non-ACCEPTED invoice", async () => {
    await expect(
      createCreditNote(
        {
          companyId,
          internalReference: "nc-ref-2",
          invoiceId: pendingInvoiceId,
          document: noteDocument(),
          discrepancyResponse: { responseCode: "2", description: "test" },
        },
        { secretStore: fakeSecretStore, createProvider: () => fakeProvider() },
      ),
    ).rejects.toThrow(/not ACCEPTED/);
  });

  it("marks the credit note ERROR and rethrows when the provider fails", async () => {
    const createCreditNoteMock = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      createCreditNote(
        {
          companyId,
          internalReference: "nc-ref-3",
          invoiceId: acceptedInvoiceId,
          document: noteDocument(),
          discrepancyResponse: { responseCode: "2", description: "test" },
        },
        { secretStore: fakeSecretStore, createProvider: () => fakeProvider({ createCreditNote: createCreditNoteMock }) },
      ),
    ).rejects.toThrow("network down");

    const creditNote = await prisma.creditNote.findUnique({
      where: { companyId_internalReference: { companyId, internalReference: "nc-ref-3" } },
    });
    expect(creditNote?.status).toBe("ERROR");
  });

  it("is idempotent: replaying the same internalReference never claims a second number", async () => {
    const createCreditNoteMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-nc-4", documentNumber: "TSTNC4" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const deps = {
      secretStore: fakeSecretStore,
      xmlStore: fakeXmlStore(),
      createProvider: () => fakeProvider({ createCreditNote: createCreditNoteMock, send }),
    };
    const params = {
      companyId,
      internalReference: "nc-ref-4",
      invoiceId: acceptedInvoiceId,
      document: noteDocument(),
      discrepancyResponse: { responseCode: "2", description: "test" },
    };

    const first = await createCreditNote(params, deps);
    const numberingAfterFirst = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });

    const second = await createCreditNote(params, deps);
    const numberingAfterSecond = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });

    expect(second.id).toBe(first.id);
    expect(createCreditNoteMock).toHaveBeenCalledTimes(1);
    expect(numberingAfterSecond.currentNumber).toBe(numberingAfterFirst.currentNumber);
  });

  it("falls back to CONTINGENCY when send() fails because DIAN is unreachable, and retry-send later accepts it", async () => {
    const createCreditNoteMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed-nc-contingency/>", uuid: "cufe-nc-5", documentNumber: "TSTNC5" });
    const failingSend = vi.fn().mockRejectedValue(new DianTransportError("DIAN unreachable"));
    const xmlStore = fakeXmlStore();

    const contingencyNote = await createCreditNote(
      {
        companyId,
        internalReference: "nc-ref-5",
        invoiceId: acceptedInvoiceId,
        document: noteDocument(),
        discrepancyResponse: { responseCode: "2", description: "test" },
      },
      { secretStore: fakeSecretStore, xmlStore, createProvider: () => fakeProvider({ createCreditNote: createCreditNoteMock, send: failingSend }) },
    );

    expect(contingencyNote.status).toBe("CONTINGENCY");
    expect(contingencyNote.noteNumber).toBe("TSTNC5");

    const workingSend = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const accepted = await retryCreditNoteSend(companyId, contingencyNote.id, undefined, {
      secretStore: fakeSecretStore,
      xmlStore,
      createProvider: () => fakeProvider({ send: workingSend }),
    });

    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.noteNumber).toBe("TSTNC5");
    const [resent] = workingSend.mock.calls[0] as [{ signedXml: string }];
    expect(resent.signedXml).toBe("<signed-nc-contingency/>");
  });
});
