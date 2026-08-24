import { DianTransportError } from "@dian-kit/sdk-node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../providers/certificates/CertificateSecretStore.js";
import type { DianProvider } from "../providers/dian/DianProvider.js";
import type { DocumentXmlStore } from "../providers/documents/DocumentXmlStore.js";
import { retryAllContingencyDocuments } from "./contingencyRetry.job.js";

const TEST_NIT = "999000006";
const TEST_DV = "1";

const fakeSecretStore: CertificateSecretStore = {
  save: vi.fn(),
  get: vi.fn().mockResolvedValue({ p12: Buffer.from("fake"), password: "fake" }),
  delete: vi.fn(),
};

function fakeXmlStore(seed: Record<string, string> = {}): DocumentXmlStore {
  const files = new Map(Object.entries(seed));
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
    data: { name: "Test Co Contingency Sweep", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;

  await prisma.dianConfiguration.create({
    data: {
      companyId,
      environment: "SANDBOX",
      softwareId: "sw-id",
      softwarePin: "sw-pin",
      technicalKey: "tech-key",
      supplierProfile: { name: "Test Co Contingency Sweep" },
    },
  });

  const numbering = await prisma.numberingResolution.create({
    data: {
      companyId,
      documentType: "01",
      prefix: "TSTC",
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

async function seedContingencyInvoice(internalReference: string, xmlReference: string) {
  return prisma.invoice.create({
    data: {
      companyId,
      numberingId,
      internalReference,
      invoiceNumber: `TSTC${internalReference}`,
      prefix: "TSTC",
      cufe: `cufe-${internalReference}`,
      xmlReference,
      status: "CONTINGENCY",
      issuedAt: new Date(),
    },
  });
}

describe("retryAllContingencyDocuments", () => {
  it("retries every CONTINGENCY invoice, tallying accepted vs. still-contingency, and never lets one failure stop the sweep", async () => {
    const acceptedInvoice = await seedContingencyInvoice("sweep-accepted", "xml-ref-accepted");
    const stillDownInvoice = await seedContingencyInvoice("sweep-still-down", "xml-ref-still-down");
    const brokenInvoice = await seedContingencyInvoice("sweep-broken", "xml-ref-broken");

    const xmlStore = fakeXmlStore({
      "xml-ref-accepted": "<signed-accepted/>",
      "xml-ref-still-down": "<signed-still-down/>",
      // Deliberately no entry for "xml-ref-broken" — xmlStore.get() will throw,
      // simulating an unexpected failure that must not abort the whole sweep.
    });

    // Deterministic by document number, not call order: retryAllContingencyDocuments
    // sweeps every company, so other concurrently-running test files' own
    // CONTINGENCY rows may also pass through this same fake provider — keying
    // off documentNumber (not "the Nth call") keeps this test correct regardless
    // of what else the sweep happens to pick up at the same time.
    const createProvider = () =>
      fakeProvider({
        send: vi.fn().mockImplementation(async (document: { documentNumber: string }) => {
          if (document.documentNumber === acceptedInvoice.invoiceNumber) {
            return { isValid: true, statusCode: "00", statusDescription: "ok", errors: [], rawResponse: "" };
          }
          throw new DianTransportError("still down");
        }),
      });

    // Note: retryAllContingencyDocuments sweeps every company in the database,
    // not just this test's — other test files may have their own CONTINGENCY
    // rows alive concurrently (vitest runs files in parallel by default), so
    // only lower-bound assertions on the aggregate summary are reliable here.
    // The three seeded invoices below are asserted individually, by id.
    const summary = await retryAllContingencyDocuments(undefined, {
      secretStore: fakeSecretStore,
      xmlStore,
      createProvider,
    });

    expect(summary.attempted).toBeGreaterThanOrEqual(3);

    const accepted = await prisma.invoice.findUniqueOrThrow({ where: { id: acceptedInvoice.id } });
    expect(accepted.status).toBe("ACCEPTED");

    const stillDown = await prisma.invoice.findUniqueOrThrow({ where: { id: stillDownInvoice.id } });
    expect(stillDown.status).toBe("CONTINGENCY");

    const broken = await prisma.invoice.findUniqueOrThrow({ where: { id: brokenInvoice.id } });
    expect(broken.status).toBe("CONTINGENCY"); // untouched — the sweep couldn't even load its XML, so it's left as-is for the next sweep
  });
});
