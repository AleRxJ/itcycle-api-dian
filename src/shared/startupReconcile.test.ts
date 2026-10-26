import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../infrastructure/prisma.js";
import { createInvoice } from "../modules/documents/invoice.service.js";
import type { CertificateSecretStore } from "../providers/certificates/CertificateSecretStore.js";
import type { DianProvider } from "../providers/dian/DianProvider.js";
import type { DocumentXmlStore } from "../providers/documents/DocumentXmlStore.js";
import { extractSignedIdentifiers, reconcileOrphanedProcessingDocuments } from "./startupReconcile.js";

// Same approach as invoice.service.test.ts: real database, fake DianProvider /
// stores, nothing ever reaches dian-kit or DIAN.

const TEST_NIT = "999000077";
const TEST_DV = "3";

const fakeSecretStore: CertificateSecretStore = {
  save: vi.fn(),
  get: vi.fn().mockResolvedValue({ p12: Buffer.from("fake"), password: "fake" }),
  delete: vi.fn(),
};

function fakeXmlStore(files = new Map<string, string>()): DocumentXmlStore {
  return {
    save: vi.fn(async (ref: string, xml: string) => {
      files.set(ref, xml);
    }),
    get: vi.fn(async (ref: string) => {
      const xml = files.get(ref);
      if (xml === undefined) throw Object.assign(new Error(`no xml stored for ${ref}`), { code: "ENOENT" });
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
    createPayrollDocument: vi.fn(),
    createPayrollAdjustment: vi.fn(),
    send: vi.fn(),
    getStatus: vi.fn(),
    getStatusZip: vi.fn(),
    getNumberingRange: vi.fn(),
    lookupBuyer: vi.fn(),
    ...overrides,
  };
}

const invoiceInput = () => ({
  issueDate: new Date().toISOString(),
  issueTime: new Date().toISOString(),
  customer: {},
  lines: [],
  taxTotals: [],
  legalMonetaryTotal: {},
  paymentMeans: {},
});

const SIGNED_UBL =
  '<Invoice><ext:UBLExtensions/><cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID><cbc:ProfileExecutionID>2</cbc:ProfileExecutionID>' +
  '<cbc:ID>TSTO7</cbc:ID><cbc:UUID schemeName="CUFE-SHA384">cufe-orphan-7</cbc:UUID></Invoice>';

let companyId: string;
let numberingId: string;
const longAgo = () => new Date(Date.now() - 60 * 60 * 1000);

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
  const company = await prisma.company.create({ data: { name: "Test Co Orphans", nit: TEST_NIT, dv: TEST_DV, personType: "1" } });
  companyId = company.id;
  await prisma.dianConfiguration.create({
    data: { companyId, environment: "SANDBOX", softwareId: "sw-id", softwarePin: "sw-pin", technicalKey: "tech-key", supplierProfile: { name: "Test Co Orphans" } },
  });
  const numbering = await prisma.numberingResolution.create({
    data: {
      companyId,
      documentType: "01",
      prefix: "TSTO",
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
    data: { companyId, provider: "test", certificateIdentifier: "test-cert", secretReference: "test-secret", expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365) },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("extractSignedIdentifiers", () => {
  it("reads the document's own number and CUFE, not a referenced invoice's", () => {
    const note =
      '<CreditNote><cbc:ProfileExecutionID>2</cbc:ProfileExecutionID><cbc:ID>NC5</cbc:ID><cbc:UUID>cude-5</cbc:UUID>' +
      "<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>FE1</cbc:ID><cbc:UUID>cufe-1</cbc:UUID></cac:InvoiceDocumentReference></cac:BillingReference></CreditNote>";
    expect(extractSignedIdentifiers(note, "ubl")).toEqual({ number: "NC5", uuid: "cude-5" });
    expect(extractSignedIdentifiers("<NominaIndividual><Encabezado><CUNE>cune-9</CUNE><NumeroSecuenciaXML><Consecutivo>NE9</Consecutivo></NumeroSecuenciaXML></Encabezado></NominaIndividual>", "payroll")).toEqual({ number: "NE9", uuid: "cune-9" });
  });
});

describe("reconcileOrphanedProcessingDocuments", () => {
  it("leaves a PROCESSING document that is still being worked on alone", async () => {
    const fresh = await prisma.invoice.create({ data: { companyId, internalReference: "orph-fresh", numberingId, status: "PROCESSING" } });
    await reconcileOrphanedProcessingDocuments(undefined, { xmlStore: fakeXmlStore() });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("PROCESSING");
  });

  it("an orphan whose signed XML was stored goes to CONTINGENCY with that exact number and CUFE", async () => {
    const row = await prisma.invoice.create({ data: { companyId, internalReference: "orph-signed", numberingId, status: "PROCESSING" } });
    await prisma.invoice.update({ where: { id: row.id }, data: { updatedAt: longAgo() } });
    const files = new Map([[row.id, SIGNED_UBL]]);
    const summary = await reconcileOrphanedProcessingDocuments(undefined, { xmlStore: fakeXmlStore(files) });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: row.id } });
    expect(summary.invoices).toBe(1);
    expect(after.status).toBe("CONTINGENCY");
    expect(after.invoiceNumber).toBe("TSTO7");
    expect(after.cufe).toBe("cufe-orphan-7");
    expect(after.xmlReference).toBe(row.id);
    expect(after.prefix).toBe("TSTO");
  });

  it("an orphan that never got signed becomes ERROR, and replaying the same internalReference issues it afresh", async () => {
    const row = await prisma.invoice.create({ data: { companyId, internalReference: "orph-unsent", numberingId, status: "PROCESSING" } });
    await prisma.invoice.update({ where: { id: row.id }, data: { updatedAt: longAgo() } });
    await reconcileOrphanedProcessingDocuments(undefined, { xmlStore: fakeXmlStore() });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("ERROR");

    const createInvoiceMock = vi.fn().mockResolvedValue({ xml: "<xml/>", signedXml: "<signed/>", uuid: "cufe-retry", documentNumber: "TSTO2" });
    const send = vi.fn().mockResolvedValue({ isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" });
    const result = await createInvoice(
      { companyId, internalReference: "orph-unsent", invoice: invoiceInput() },
      { secretStore: fakeSecretStore, xmlStore: fakeXmlStore(), createProvider: () => fakeProvider({ createInvoice: createInvoiceMock, send }) },
    );
    expect(result.status).toBe("ACCEPTED");
    expect(result.id).not.toBe(row.id);
    const old = await prisma.invoice.findUniqueOrThrow({ where: { id: row.id } });
    expect(old.status).toBe("ERROR");
    expect(old.internalReference).toMatch(/^orph-unsent~failed-/);
  });

  it("an ERROR that did get signed is never re-issued by a replay", async () => {
    const row = await prisma.invoice.create({ data: { companyId, internalReference: "err-signed", numberingId, status: "ERROR", xmlReference: "x" } });
    const createInvoiceMock = vi.fn();
    const result = await createInvoice(
      { companyId, internalReference: "err-signed", invoice: invoiceInput() },
      { secretStore: fakeSecretStore, xmlStore: fakeXmlStore(), createProvider: () => fakeProvider({ createInvoice: createInvoiceMock }) },
    );
    expect(result.id).toBe(row.id);
    expect(createInvoiceMock).not.toHaveBeenCalled();
  });
});
