import { DianTransportError } from "@dian-kit/sdk-node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import type { DocumentXmlStore } from "../../providers/documents/DocumentXmlStore.js";
import { createInvoice, retryInvoiceSend } from "./invoice.service.js";

// Same approach as test-invoice.service.test.ts: exercises idempotency,
// status transitions, and server-side numbering against the real dev
// database, with a fake DianProvider/CertificateSecretStore injected so
// nothing here ever calls dian-kit or DIAN.

const TEST_NIT = "999000002";
const TEST_DV = "1";

const fakeSecretStore: CertificateSecretStore = {
  save: vi.fn(),
  get: vi.fn().mockResolvedValue({ p12: Buffer.from("fake"), password: "fake" }),
  delete: vi.fn(),
};

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

function invoiceInput() {
  return {
    // Deliberately includes an `id` — production numbering must ignore it.
    id: "CALLER-CHOSEN-ID",
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
let numberingId: string;

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
    data: { name: "Test Co Invoices", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;

  await prisma.dianConfiguration.create({
    data: {
      companyId,
      environment: "SANDBOX",
      softwareId: "sw-id",
      softwarePin: "sw-pin",
      technicalKey: "tech-key",
      supplierProfile: { name: "Test Co Invoices" },
    },
  });
  const numbering = await prisma.numberingResolution.create({
    data: {
      companyId,
      documentType: "01",
      prefix: "TSTI",
      resolutionNumber: "123",
      startNumber: 1,
      endNumber: 1000,
      currentNumber: 1,
      startDate: new Date(),
      endDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    },
  });
  numberingId = numbering.id;
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

describe("createInvoice", () => {
  it("claims the document id from NumberingResolution, ignoring any id in the request body", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-1", documentNumber: "TSTI1" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });

    const result = await createInvoice(
      { companyId, internalReference: "ref-1", invoice: invoiceInput() },
      {
        secretStore: fakeSecretStore,
        xmlStore: fakeXmlStore(),
        createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send }),
      },
    );

    expect(result.status).toBe("ACCEPTED");
    expect(createInvoiceMock).toHaveBeenCalledTimes(1);
    const [inputArg] = createInvoiceMock.mock.calls[0] as [{ id: string }];
    expect(inputArg.id).toBe("TSTI1");
    expect(inputArg.id).not.toBe("CALLER-CHOSEN-ID");

    const numbering = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });
    expect(numbering.currentNumber).toBe(2);
  });

  it("rejects an invoice when DIAN reports validation errors", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-2", documentNumber: "TSTI2" });
    const send = vi.fn().mockResolvedValue({
      isValid: false,
      statusCode: "99",
      statusDescription: "rejected",
      errors: [{ code: "FAD06", description: "boom" }],
      rawResponse: "",
    });

    const result = await createInvoice(
      { companyId, internalReference: "ref-2", invoice: invoiceInput() },
      {
        secretStore: fakeSecretStore,
        xmlStore: fakeXmlStore(),
        createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send }),
      },
    );

    expect(result.status).toBe("REJECTED");
    expect(result.errorMessage).toContain("boom");
  });

  it("lands in SENT (not ACCEPTED) with trackId persisted for an async send, since the ack isn't DIAN's final verdict", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-async-1", documentNumber: "TSTI-ASYNC-1" });
    // Async sends (SendTestSetAsync/SendBillAsync) return a trackId — isValid:true
    // here is only an acknowledgment, not the real result (see computeSentStatusFields).
    const send = vi.fn().mockResolvedValue({
      isValid: true,
      statusCode: "01",
      statusDescription: "Procesando",
      trackId: "track-123",
      errors: [],
      rawResponse: "",
    });

    const result = await createInvoice(
      { companyId, internalReference: "ref-async-1", invoice: invoiceInput(), send: { method: "SendTestSetAsync", testSetId: "test-set-1" } },
      {
        secretStore: fakeSecretStore,
        xmlStore: fakeXmlStore(),
        createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send }),
      },
    );

    expect(result.status).toBe("SENT");
    expect(result.trackId).toBe("track-123");
    expect(result.acceptedAt).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it("marks the invoice ERROR and rethrows when the provider fails", async () => {
    const createInvoiceMock = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      createInvoice(
        { companyId, internalReference: "ref-3", invoice: invoiceInput() },
        { secretStore: fakeSecretStore, createProvider: () => fakeProvider({ createInvoice: createInvoiceMock }) },
      ),
    ).rejects.toThrow("network down");

    const invoice = await prisma.invoice.findUnique({
      where: { companyId_internalReference: { companyId, internalReference: "ref-3" } },
    });
    expect(invoice?.status).toBe("ERROR");
  });

  it("is idempotent: replaying the same internalReference never claims a second number", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-4", documentNumber: "TSTI4" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const deps = {
      secretStore: fakeSecretStore,
      xmlStore: fakeXmlStore(),
      createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send }),
    };

    const first = await createInvoice({ companyId, internalReference: "ref-4", invoice: invoiceInput() }, deps);
    const numberingAfterFirst = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });

    const second = await createInvoice({ companyId, internalReference: "ref-4", invoice: invoiceInput() }, deps);
    const numberingAfterSecond = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });

    expect(second.id).toBe(first.id);
    expect(createInvoiceMock).toHaveBeenCalledTimes(1);
    expect(numberingAfterSecond.currentNumber).toBe(numberingAfterFirst.currentNumber);
  });

  it("falls back to CONTINGENCY (not ERROR) when send() fails because DIAN is unreachable", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed-xml-for-contingency/>", uuid: "cufe-5", documentNumber: "TSTI5" });
    const send = vi.fn().mockRejectedValue(new DianTransportError("Timeout: el servicio DIAN no respondió"));
    const xmlStore = fakeXmlStore();

    const result = await createInvoice(
      { companyId, internalReference: "ref-5", invoice: invoiceInput() },
      { secretStore: fakeSecretStore, xmlStore, createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send }) },
    );

    expect(result.status).toBe("CONTINGENCY");
    expect(result.invoiceNumber).toBe("TSTI5");
    expect(result.cufe).toBe("cufe-5");
    expect(result.xmlReference).toBe(result.id);
    expect(await xmlStore.get(result.xmlReference!)).toBe("<signed-xml-for-contingency/>");
  });

  it("a non-DianTransportError from send() still marks the invoice ERROR, not CONTINGENCY", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-6", documentNumber: "TSTI6" });
    const send = vi.fn().mockRejectedValue(new Error("unexpected bug, not a DIAN outage"));

    await expect(
      createInvoice(
        { companyId, internalReference: "ref-6", invoice: invoiceInput() },
        { secretStore: fakeSecretStore, xmlStore: fakeXmlStore(), createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send }) },
      ),
    ).rejects.toThrow("unexpected bug, not a DIAN outage");

    const invoice = await prisma.invoice.findUnique({
      where: { companyId_internalReference: { companyId, internalReference: "ref-6" } },
    });
    expect(invoice?.status).toBe("ERROR");
  });
});

describe("retryInvoiceSend", () => {
  it("stays CONTINGENCY when DIAN is still unreachable, without losing the already-delivered document", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed-xml-retry/>", uuid: "cufe-retry-1", documentNumber: "TSTI7" });
    const failingSend = vi.fn().mockRejectedValue(new DianTransportError("still down"));
    const xmlStore = fakeXmlStore();
    const secretStore = fakeSecretStore;

    const contingencyInvoice = await createInvoice(
      { companyId, internalReference: "ref-7", invoice: invoiceInput() },
      { secretStore, xmlStore, createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send: failingSend }) },
    );
    expect(contingencyInvoice.status).toBe("CONTINGENCY");

    const stillFailingSend = vi.fn().mockRejectedValue(new DianTransportError("still down"));
    const retried = await retryInvoiceSend(companyId, contingencyInvoice.id, undefined, {
      secretStore,
      xmlStore,
      createProvider: () => fakeProvider({ send: stillFailingSend }),
    });

    expect(retried.status).toBe("CONTINGENCY");
    expect(stillFailingSend).toHaveBeenCalledTimes(1);
    const [resentDocument] = stillFailingSend.mock.calls[0] as [{ signedXml: string; documentNumber: string }];
    expect(resentDocument.signedXml).toBe("<signed-xml-retry/>");
    expect(resentDocument.documentNumber).toBe("TSTI7");
  });

  it("transitions CONTINGENCY to ACCEPTED once DIAN responds, reusing the original document number and CUFE", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed-xml-retry-2/>", uuid: "cufe-retry-2", documentNumber: "TSTI8" });
    const failingSend = vi.fn().mockRejectedValue(new DianTransportError("down at issuance time"));
    const xmlStore = fakeXmlStore();

    const contingencyInvoice = await createInvoice(
      { companyId, internalReference: "ref-8", invoice: invoiceInput() },
      { secretStore: fakeSecretStore, xmlStore, createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send: failingSend }) },
    );

    const nowWorkingSend = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const accepted = await retryInvoiceSend(companyId, contingencyInvoice.id, undefined, {
      secretStore: fakeSecretStore,
      xmlStore,
      createProvider: () => fakeProvider({ send: nowWorkingSend }),
    });

    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.invoiceNumber).toBe("TSTI8");
    expect(accepted.cufe).toBe("cufe-retry-2");
  });

  it("refuses to retry a document that isn't in CONTINGENCY", async () => {
    const createInvoiceMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-9", documentNumber: "TSTI9" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });

    const acceptedInvoice = await createInvoice(
      { companyId, internalReference: "ref-9", invoice: invoiceInput() },
      { secretStore: fakeSecretStore, xmlStore: fakeXmlStore(), createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send }) },
    );

    await expect(
      retryInvoiceSend(companyId, acceptedInvoice.id, undefined, { secretStore: fakeSecretStore, xmlStore: fakeXmlStore() }),
    ).rejects.toThrow(/not in CONTINGENCY/);
  });
});
