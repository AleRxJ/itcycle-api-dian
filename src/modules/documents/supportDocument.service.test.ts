import { DianTransportError } from "@dian-kit/sdk-node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import type { DocumentXmlStore } from "../../providers/documents/DocumentXmlStore.js";
import { createSupportDocument, retrySupportDocumentSend } from "./supportDocument.service.js";

// Same approach as invoice.service.test.ts: exercises idempotency, status
// transitions, and server-side numbering against the real dev database,
// with a fake DianProvider/CertificateSecretStore injected so nothing here
// ever calls dian-kit or DIAN.

const TEST_NIT = "999000010";
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

function supportDocumentInput() {
  return {
    // Deliberately includes an `id` — production numbering must ignore it.
    id: "CALLER-CHOSEN-ID",
    issueDate: new Date().toISOString(),
    issueTime: new Date().toISOString(),
    // `customer` here represents the real-world SELLER (non-obligated to
    // invoice) — see supportDocument.service.ts's doc comment on the party
    // role reversal for Documento Soporte.
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
  await prisma.supportDocument.deleteMany({ where: { companyId: company.id } });
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.numberingResolution.deleteMany({ where: { companyId: company.id } });
  await prisma.dianConfiguration.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(async () => {
  await cleanup();

  const company = await prisma.company.create({
    data: { name: "Test Co Support Documents", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;

  await prisma.dianConfiguration.create({
    data: {
      companyId,
      environment: "SANDBOX",
      softwareId: "sw-id",
      softwarePin: "sw-pin",
      technicalKey: "tech-key",
      supplierProfile: { name: "Test Co Support Documents" },
    },
  });
  const numbering = await prisma.numberingResolution.create({
    data: {
      companyId,
      documentType: "05",
      prefix: "TSTS",
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

describe("createSupportDocument", () => {
  it("claims the document id from NumberingResolution (documentType 05), ignoring any id in the request body", async () => {
    const createSupportDocumentMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cude-1", documentNumber: "TSTS1" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });

    const result = await createSupportDocument(
      { companyId, internalReference: "ref-1", document: supportDocumentInput() },
      {
        secretStore: fakeSecretStore,
        xmlStore: fakeXmlStore(),
        createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send }),
      },
    );

    expect(result.status).toBe("ACCEPTED");
    expect(createSupportDocumentMock).toHaveBeenCalledTimes(1);
    const [inputArg] = createSupportDocumentMock.mock.calls[0] as [{ id: string }];
    expect(inputArg.id).toBe("TSTS1");
    expect(inputArg.id).not.toBe("CALLER-CHOSEN-ID");

    const numbering = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });
    expect(numbering.currentNumber).toBe(2);
  });

  it("does not pass billingReference/discrepancyResponse to the provider — unlike credit/debit notes", async () => {
    const createSupportDocumentMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cude-props", documentNumber: "TSTS-props" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });

    await createSupportDocument(
      { companyId, internalReference: "ref-props", document: supportDocumentInput() },
      {
        secretStore: fakeSecretStore,
        xmlStore: fakeXmlStore(),
        createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send }),
      },
    );

    const [inputArg] = createSupportDocumentMock.mock.calls[0] as [Record<string, unknown>];
    expect(inputArg).not.toHaveProperty("billingReference");
    expect(inputArg).not.toHaveProperty("discrepancyResponse");
  });

  it("rejects a support document when DIAN reports validation errors", async () => {
    const createSupportDocumentMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cude-2", documentNumber: "TSTS2" });
    const send = vi.fn().mockResolvedValue({
      isValid: false,
      statusCode: "99",
      statusDescription: "rejected",
      errors: [{ code: "FAD06", description: "boom" }],
      rawResponse: "",
    });

    const result = await createSupportDocument(
      { companyId, internalReference: "ref-2", document: supportDocumentInput() },
      {
        secretStore: fakeSecretStore,
        xmlStore: fakeXmlStore(),
        createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send }),
      },
    );

    expect(result.status).toBe("REJECTED");
    expect(result.errorMessage).toContain("boom");
  });

  it("marks the support document ERROR and rethrows when the provider fails", async () => {
    const createSupportDocumentMock = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      createSupportDocument(
        { companyId, internalReference: "ref-3", document: supportDocumentInput() },
        {
          secretStore: fakeSecretStore,
          createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock }),
        },
      ),
    ).rejects.toThrow("network down");

    const supportDocument = await prisma.supportDocument.findUnique({
      where: { companyId_internalReference: { companyId, internalReference: "ref-3" } },
    });
    expect(supportDocument?.status).toBe("ERROR");
  });

  it("is idempotent: replaying the same internalReference never claims a second number", async () => {
    const createSupportDocumentMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cude-4", documentNumber: "TSTS4" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const deps = {
      secretStore: fakeSecretStore,
      xmlStore: fakeXmlStore(),
      createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send }),
    };

    const first = await createSupportDocument(
      { companyId, internalReference: "ref-4", document: supportDocumentInput() },
      deps,
    );
    const numberingAfterFirst = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });

    const second = await createSupportDocument(
      { companyId, internalReference: "ref-4", document: supportDocumentInput() },
      deps,
    );
    const numberingAfterSecond = await prisma.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });

    expect(second.id).toBe(first.id);
    expect(createSupportDocumentMock).toHaveBeenCalledTimes(1);
    expect(numberingAfterSecond.currentNumber).toBe(numberingAfterFirst.currentNumber);
  });

  it("falls back to CONTINGENCY (not ERROR) when send() fails because DIAN is unreachable", async () => {
    const createSupportDocumentMock = vi.fn().mockResolvedValue({
      xml: "<xml/>",
      signedXml: "<signed-xml-for-contingency/>",
      uuid: "cude-5",
      documentNumber: "TSTS5",
    });
    const send = vi.fn().mockRejectedValue(new DianTransportError("Timeout: el servicio DIAN no respondió"));
    const xmlStore = fakeXmlStore();

    const result = await createSupportDocument(
      { companyId, internalReference: "ref-5", document: supportDocumentInput() },
      {
        secretStore: fakeSecretStore,
        xmlStore,
        createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send }),
      },
    );

    expect(result.status).toBe("CONTINGENCY");
    expect(result.documentNumber).toBe("TSTS5");
    expect(result.cufe).toBe("cude-5");
    expect(result.xmlReference).toBe(result.id);
    expect(await xmlStore.get(result.xmlReference!)).toBe("<signed-xml-for-contingency/>");
  });

  it("a non-DianTransportError from send() still marks the support document ERROR, not CONTINGENCY", async () => {
    const createSupportDocumentMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cude-6", documentNumber: "TSTS6" });
    const send = vi.fn().mockRejectedValue(new Error("unexpected bug, not a DIAN outage"));

    await expect(
      createSupportDocument(
        { companyId, internalReference: "ref-6", document: supportDocumentInput() },
        {
          secretStore: fakeSecretStore,
          xmlStore: fakeXmlStore(),
          createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send }),
        },
      ),
    ).rejects.toThrow("unexpected bug, not a DIAN outage");

    const supportDocument = await prisma.supportDocument.findUnique({
      where: { companyId_internalReference: { companyId, internalReference: "ref-6" } },
    });
    expect(supportDocument?.status).toBe("ERROR");
  });
});

describe("retrySupportDocumentSend", () => {
  it("stays CONTINGENCY when DIAN is still unreachable, without losing the already-delivered document", async () => {
    const createSupportDocumentMock = vi.fn().mockResolvedValue({
      xml: "<xml/>",
      signedXml: "<signed-xml-retry/>",
      uuid: "cude-retry-1",
      documentNumber: "TSTS7",
    });
    const failingSend = vi.fn().mockRejectedValue(new DianTransportError("still down"));
    const xmlStore = fakeXmlStore();
    const secretStore = fakeSecretStore;

    const contingencyDoc = await createSupportDocument(
      { companyId, internalReference: "ref-7", document: supportDocumentInput() },
      { secretStore, xmlStore, createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send: failingSend }) },
    );
    expect(contingencyDoc.status).toBe("CONTINGENCY");

    const stillFailingSend = vi.fn().mockRejectedValue(new DianTransportError("still down"));
    const retried = await retrySupportDocumentSend(companyId, contingencyDoc.id, undefined, {
      secretStore,
      xmlStore,
      createProvider: () => fakeProvider({ send: stillFailingSend }),
    });

    expect(retried.status).toBe("CONTINGENCY");
    expect(stillFailingSend).toHaveBeenCalledTimes(1);
    const [resentDocument] = stillFailingSend.mock.calls[0] as [{ signedXml: string; documentNumber: string }];
    expect(resentDocument.signedXml).toBe("<signed-xml-retry/>");
    expect(resentDocument.documentNumber).toBe("TSTS7");
  });

  it("transitions CONTINGENCY to ACCEPTED once DIAN responds, reusing the original document number and CUDE", async () => {
    const createSupportDocumentMock = vi.fn().mockResolvedValue({
      xml: "<xml/>",
      signedXml: "<signed-xml-retry-2/>",
      uuid: "cude-retry-2",
      documentNumber: "TSTS8",
    });
    const failingSend = vi.fn().mockRejectedValue(new DianTransportError("down at issuance time"));
    const xmlStore = fakeXmlStore();

    const contingencyDoc = await createSupportDocument(
      { companyId, internalReference: "ref-8", document: supportDocumentInput() },
      {
        secretStore: fakeSecretStore,
        xmlStore,
        createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send: failingSend }),
      },
    );

    const nowWorkingSend = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const accepted = await retrySupportDocumentSend(companyId, contingencyDoc.id, undefined, {
      secretStore: fakeSecretStore,
      xmlStore,
      createProvider: () => fakeProvider({ send: nowWorkingSend }),
    });

    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.documentNumber).toBe("TSTS8");
    expect(accepted.cufe).toBe("cude-retry-2");
  });

  it("refuses to retry a document that isn't in CONTINGENCY", async () => {
    const createSupportDocumentMock = vi
      .fn()
      .mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cude-9", documentNumber: "TSTS9" });
    const send = vi
      .fn()
      .mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });

    const acceptedDoc = await createSupportDocument(
      { companyId, internalReference: "ref-9", document: supportDocumentInput() },
      {
        secretStore: fakeSecretStore,
        xmlStore: fakeXmlStore(),
        createProvider: () => fakeProvider({ createSupportDocument: createSupportDocumentMock, send }),
      },
    );

    await expect(
      retrySupportDocumentSend(companyId, acceptedDoc.id, undefined, { secretStore: fakeSecretStore, xmlStore: fakeXmlStore() }),
    ).rejects.toThrow(/not in CONTINGENCY/);
  });
});
