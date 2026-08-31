import type { DebitNoteInput, DianKitConfig, SendOptions } from "@dian-kit/sdk-node";

import { prisma } from "../../infrastructure/prisma.js";
import { DianKitProvider } from "../../providers/dian/DianKitProvider.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import { SimulatedDianProvider } from "../../providers/dian/SimulatedDianProvider.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { env } from "../../shared/env.js";
import { createDefaultDocumentXmlStore } from "../../shared/documentXmlStore.js";
import { claimNextNumber, loadDianConfig } from "./dianConfig.service.js";
import { computeSentStatusFields, reconstructDocumentForResend, sendWithContingencyHandling } from "./documentSend.service.js";
import type { DocumentServiceDeps } from "./invoice.service.js";

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
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
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
      testSetId: params.send?.testSetId ?? null,
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

    const xmlReference = debitNoteRecord.id;
    await xmlStore.save(xmlReference, document.signedXml);

    const outcome = await sendWithContingencyHandling(provider, document, params.send);

    if (outcome.kind === "contingency") {
      return await prisma.debitNote.update({
        where: { id: debitNoteRecord.id },
        data: {
          noteNumber: document.documentNumber,
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
    return await prisma.debitNote.update({
      where: { id: debitNoteRecord.id },
      data: {
        noteNumber: document.documentNumber,
        prefix: numbering.prefix,
        cufe: document.uuid,
        xmlReference,
        simulated,
        issuedAt: new Date(),
        sentAt: new Date(),
        ...computeSentStatusFields(response),
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

/** Retries sending a CONTINGENCY debit note — see retryInvoiceSend in invoice.service.ts for the full rationale. */
export async function retryDebitNoteSend(
  companyId: string,
  id: string,
  send?: SendOptions,
  deps: DocumentServiceDeps = {},
) {
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const debitNote = await prisma.debitNote.findFirst({ where: { id, companyId } });
  if (!debitNote) {
    throw new Error(`Debit note ${id} not found for company ${companyId}`);
  }
  if (debitNote.status !== "CONTINGENCY") {
    throw new Error(`Debit note ${id} is not in CONTINGENCY (status=${debitNote.status}) — nothing to retry.`);
  }
  if (!debitNote.xmlReference || !debitNote.noteNumber || !debitNote.cufe) {
    throw new Error(`Debit note ${id} is CONTINGENCY but missing xmlReference/noteNumber/cufe — cannot resend.`);
  }

  const { config } = await loadDianConfig({ companyId, documentType: "92" }, secretStore);
  const provider = createProvider(config);
  const signedXml = await xmlStore.get(debitNote.xmlReference);
  const document = reconstructDocumentForResend(signedXml, debitNote.noteNumber, debitNote.cufe);

  const outcome = await sendWithContingencyHandling(provider, document, send);

  if (outcome.kind === "contingency") {
    return await prisma.debitNote.update({ where: { id: debitNote.id }, data: { errorMessage: outcome.error.message } });
  }

  const { response } = outcome;
  return await prisma.debitNote.update({
    where: { id: debitNote.id },
    data: {
      simulated,
      sentAt: new Date(),
      ...computeSentStatusFields(response),
    },
  });
}

export async function getDebitNote(companyId: string, id: string) {
  return prisma.debitNote.findFirst({ where: { id, companyId } });
}
