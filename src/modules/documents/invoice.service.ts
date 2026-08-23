import type { DianKitConfig, InvoiceInput, SendOptions } from "@dian-kit/sdk-node";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import { DianKitProvider } from "../../providers/dian/DianKitProvider.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import { SimulatedDianProvider } from "../../providers/dian/SimulatedDianProvider.js";
import type { DocumentXmlStore } from "../../providers/documents/DocumentXmlStore.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { env } from "../../shared/env.js";
import { createDefaultDocumentXmlStore } from "../../shared/documentXmlStore.js";
import { claimNextNumber, loadDianConfig } from "./dianConfig.service.js";
import { reconstructDocumentForResend, sendWithContingencyHandling } from "./documentSend.service.js";

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
  /** @defaultValue a LocalFileCertificateSecretStore over CERTIFICATES_DIR, or EncryptedFileCertificateSecretStore when CERTIFICATE_ENCRYPTION_KEY is set */
  secretStore?: CertificateSecretStore;
  /** @defaultValue DianKitProvider, or SimulatedDianProvider when DIAN_SIMULATION_MODE=true */
  createProvider?: (config: DianKitConfig) => DianProvider;
  /** @defaultValue a LocalFileDocumentXmlStore over DOCUMENTS_DIR */
  xmlStore?: DocumentXmlStore;
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
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
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

    // Building/signing is entirely local (dian-kit) — a failure here means
    // there is no document to deliver to the customer, so it stays ERROR
    // (below, in the outer catch). Only *sending* to DIAN can turn into a
    // contingencia — see documentSend.service.ts.
    const document = await provider.createInvoice(invoiceInput);

    // Persisted before attempting send(): if DIAN is unreachable, this is
    // exactly the XML that must be re-sent later via retrySend — dian-kit's
    // XAdES-EPES signature embeds a timestamp, so re-signing would produce a
    // different document, not a retry of the same one.
    const xmlReference = invoiceRecord.id;
    await xmlStore.save(xmlReference, document.signedXml);

    const outcome = await sendWithContingencyHandling(provider, document, params.send);

    if (outcome.kind === "contingency") {
      return await prisma.invoice.update({
        where: { id: invoiceRecord.id },
        data: {
          invoiceNumber: document.documentNumber,
          prefix: numbering.prefix,
          cufe: document.uuid,
          xmlReference,
          status: "CONTINGENCY",
          simulated,
          issuedAt: new Date(),
          errorMessage: outcome.error.message,
        },
      });
    }

    const { response } = outcome;
    return await prisma.invoice.update({
      where: { id: invoiceRecord.id },
      data: {
        invoiceNumber: document.documentNumber,
        prefix: numbering.prefix,
        cufe: document.uuid,
        xmlReference,
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

/**
 * Retries sending a CONTINGENCY invoice to DIAN — reuses the exact
 * previously-signed XML (never regenerated) and the same document number
 * and CUFE the customer already received. Stays CONTINGENCY if DIAN is
 * still unreachable; transitions to ACCEPTED/REJECTED once DIAN responds.
 * A REJECTED reached this way does not retroactively invalidate the
 * document already delivered to the customer (a support/process concern,
 * not something this status machine needs to model separately).
 */
export async function retryInvoiceSend(
  companyId: string,
  id: string,
  send?: SendOptions,
  deps: DocumentServiceDeps = {},
) {
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const invoice = await prisma.invoice.findFirst({ where: { id, companyId } });
  if (!invoice) {
    throw new Error(`Invoice ${id} not found for company ${companyId}`);
  }
  if (invoice.status !== "CONTINGENCY") {
    throw new Error(`Invoice ${id} is not in CONTINGENCY (status=${invoice.status}) — nothing to retry.`);
  }
  if (!invoice.xmlReference || !invoice.invoiceNumber || !invoice.cufe) {
    throw new Error(`Invoice ${id} is CONTINGENCY but missing xmlReference/invoiceNumber/cufe — cannot resend.`);
  }

  const { config } = await loadDianConfig({ companyId, documentType: "01" }, secretStore);
  const provider = createProvider(config);
  const signedXml = await xmlStore.get(invoice.xmlReference);
  const document = reconstructDocumentForResend(signedXml, invoice.invoiceNumber, invoice.cufe);

  const outcome = await sendWithContingencyHandling(provider, document, send);

  if (outcome.kind === "contingency") {
    return await prisma.invoice.update({
      where: { id: invoice.id },
      data: { errorMessage: outcome.error.message },
    });
  }

  const { response } = outcome;
  return await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: response.isValid ? "ACCEPTED" : "REJECTED",
      simulated,
      sentAt: new Date(),
      acceptedAt: response.isValid ? new Date() : null,
      errorMessage: response.errors?.map((e) => e.description).join("; ") || null,
    },
  });
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
