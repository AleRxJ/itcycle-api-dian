import type { DianKitConfig, InvoiceInput, SendOptions } from "@dian-kit/sdk-node";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import { LocalFileCertificateSecretStore } from "../../providers/certificates/LocalFileCertificateSecretStore.js";
import { DianKitProvider } from "../../providers/dian/DianKitProvider.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import { SimulatedDianProvider } from "../../providers/dian/SimulatedDianProvider.js";
import { env } from "../../shared/env.js";
import { claimNextNumber, loadDianConfig } from "./dianConfig.service.js";

const defaultSecretStore = new LocalFileCertificateSecretStore(env.certificatesDir);

function defaultCreateProvider(config: DianKitConfig): DianProvider {
  return env.dianSimulationMode ? new SimulatedDianProvider(config) : new DianKitProvider(config);
}

export interface CreateInvoiceParams {
  companyId: string;
  internalReference: string;
  invoice: Record<string, unknown>;
  send?: SendOptions;
}

export interface DocumentServiceDeps {
  /** @defaultValue a LocalFileCertificateSecretStore over CERTIFICATES_DIR */
  secretStore?: CertificateSecretStore;
  /** @defaultValue DianKitProvider, or SimulatedDianProvider when DIAN_SIMULATION_MODE=true */
  createProvider?: (config: DianKitConfig) => DianProvider;
}

/**
 * Production invoice issuance: POST /api/v1/documents/invoices.
 *
 * Unlike test-invoice.service.ts (dev-only, caller picks the document `id`),
 * this always claims the next number from the company's ACTIVE
 * NumberingResolution for documentType "01" — any `id` present in the
 * request's `invoice` object is ignored.
 */
export async function createInvoice(params: CreateInvoiceParams, deps: DocumentServiceDeps = {}) {
  const secretStore = deps.secretStore ?? defaultSecretStore;
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const existing = await prisma.invoice.findUnique({
    where: {
      companyId_internalReference: {
        companyId: params.companyId,
        internalReference: params.internalReference,
      },
    },
  });
  if (existing) {
    // Idempotent replay: never re-send the same internalReference to DIAN,
    // and never burn a second document number for it.
    return existing;
  }

  const { numbering, certificateId, config } = await loadDianConfig(
    { companyId: params.companyId, documentType: "01" },
    secretStore,
  );
  const { documentId } = await claimNextNumber(numbering.id);

  const invoiceRecord = await prisma.invoice.create({
    data: {
      companyId: params.companyId,
      internalReference: params.internalReference,
      numberingId: numbering.id,
      certificateId,
      status: "PROCESSING",
    },
  });

  try {
    const provider = createProvider(config);
    const invoiceInput = toInvoiceInput(params.invoice, documentId);

    const document = await provider.createInvoice(invoiceInput);
    const response = await provider.send(document, params.send);

    return await prisma.invoice.update({
      where: { id: invoiceRecord.id },
      data: {
        invoiceNumber: document.documentNumber,
        prefix: numbering.prefix,
        cufe: document.uuid,
        status: response.isValid ? "ACCEPTED" : "REJECTED",
        simulated,
        issuedAt: new Date(),
        sentAt: new Date(),
        acceptedAt: response.isValid ? new Date() : null,
        errorMessage: response.errors?.map((e) => e.description).join("; ") || null,
      },
    });
  } catch (error) {
    await prisma.invoice.update({
      where: { id: invoiceRecord.id },
      data: {
        status: "ERROR",
        simulated,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function getInvoice(companyId: string, id: string) {
  return prisma.invoice.findFirst({ where: { id, companyId } });
}

/**
 * Converts the JSON request body into dian-kit's InvoiceInput shape,
 * injecting the server-claimed document id and stripping any `id` the
 * caller may have sent — production numbering is never caller-supplied.
 * Dates arrive as ISO strings over HTTP; everything else is passed through
 * as-is and validated by dian-kit's own Zod schema inside createInvoice.
 */
function toInvoiceInput(raw: Record<string, unknown>, documentId: string): InvoiceInput {
  return {
    ...raw,
    id: documentId,
    issueDate: new Date(raw.issueDate as string),
    issueTime: new Date(raw.issueTime as string),
  } as InvoiceInput;
}
