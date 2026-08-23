import type { DebitNoteInput, DianKitConfig, SendOptions } from "@dian-kit/sdk-node";

import { prisma } from "../../infrastructure/prisma.js";
import { LocalFileCertificateSecretStore } from "../../providers/certificates/LocalFileCertificateSecretStore.js";
import { DianKitProvider } from "../../providers/dian/DianKitProvider.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import { SimulatedDianProvider } from "../../providers/dian/SimulatedDianProvider.js";
import { env } from "../../shared/env.js";
import { claimNextNumber, loadDianConfig } from "./dianConfig.service.js";
import type { DocumentServiceDeps } from "./invoice.service.js";

const defaultSecretStore = new LocalFileCertificateSecretStore(env.certificatesDir);

function defaultCreateProvider(config: DianKitConfig): DianProvider {
  return env.dianSimulationMode ? new SimulatedDianProvider(config) : new DianKitProvider(config);
}

export interface CreateDebitNoteParams {
  companyId: string;
  internalReference: string;
  invoiceId: string;
  document: Record<string, unknown>;
  discrepancyResponse: { responseCode: string; description: string };
  send?: SendOptions;
}

/**
 * Production debit-note issuance: POST /api/v1/documents/debit-notes.
 * Mirrors createCreditNote — see that file's comment for why invoiceId
 * (not a raw billingReference) is the input, and why ACCEPTED is required.
 */
export async function createDebitNote(params: CreateDebitNoteParams, deps: DocumentServiceDeps = {}) {
  const secretStore = deps.secretStore ?? defaultSecretStore;
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const existing = await prisma.debitNote.findUnique({
    where: {
      companyId_internalReference: {
        companyId: params.companyId,
        internalReference: params.internalReference,
      },
    },
  });
  if (existing) {
    return existing;
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: params.invoiceId, companyId: params.companyId },
  });
  if (!invoice) {
    throw new Error(`Invoice ${params.invoiceId} not found for company ${params.companyId}`);
  }
  if (invoice.status !== "ACCEPTED" || !invoice.cufe || !invoice.invoiceNumber || !invoice.issuedAt) {
    throw new Error(
      `Invoice ${params.invoiceId} is not ACCEPTED (status=${invoice.status}) — a debit note can only ` +
        "reference an invoice DIAN has already accepted.",
    );
  }

  const { numbering, certificateId, config } = await loadDianConfig(
    { companyId: params.companyId, documentType: "92" },
    secretStore,
  );
  const { documentId } = await claimNextNumber(numbering.id);

  const debitNoteRecord = await prisma.debitNote.create({
    data: {
      companyId: params.companyId,
      invoiceId: invoice.id,
      internalReference: params.internalReference,
      numberingId: numbering.id,
      certificateId,
      discrepancyResponseCode: params.discrepancyResponse.responseCode,
      discrepancyDescription: params.discrepancyResponse.description,
      status: "PROCESSING",
    },
  });

  try {
    const provider = createProvider(config);
    const input: DebitNoteInput = {
      ...(params.document as object),
      id: documentId,
      issueDate: new Date(params.document.issueDate as string),
      issueTime: new Date(params.document.issueTime as string),
      billingReference: {
        id: invoice.invoiceNumber,
        uuid: invoice.cufe,
        issueDate: invoice.issuedAt,
      },
      discrepancyResponse: {
        referenceId: invoice.invoiceNumber,
        responseCode: params.discrepancyResponse.responseCode,
        description: params.discrepancyResponse.description,
      },
    } as DebitNoteInput;

    const document = await provider.createDebitNote(input);
    const response = await provider.send(document, params.send);

    return await prisma.debitNote.update({
      where: { id: debitNoteRecord.id },
      data: {
        noteNumber: document.documentNumber,
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
    await prisma.debitNote.update({
      where: { id: debitNoteRecord.id },
      data: {
        status: "ERROR",
        simulated,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function getDebitNote(companyId: string, id: string) {
  return prisma.debitNote.findFirst({ where: { id, companyId } });
}
