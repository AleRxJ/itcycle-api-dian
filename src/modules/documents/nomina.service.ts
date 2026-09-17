import type { DianKitConfig, PayrollAdjustmentInput, PayrollInput, SendOptions } from "@dian-kit/sdk-node";

import { prisma } from "../../infrastructure/prisma.js";
import { DianKitProvider } from "../../providers/dian/DianKitProvider.js";
import type { DianProvider } from "../../providers/dian/DianProvider.js";
import { SimulatedDianProvider } from "../../providers/dian/SimulatedDianProvider.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { env } from "../../shared/env.js";
import { createDefaultDocumentXmlStore } from "../../shared/documentXmlStore.js";
import { createDefaultRawResponseStore } from "../../shared/rawResponseStore.js";
import { claimNextNumber, loadDianConfig } from "./dianConfig.service.js";
import { computeSentStatusFields, reconstructDocumentForResend, sendWithContingencyHandling } from "./documentSend.service.js";
import type { DocumentServiceDeps } from "./invoice.service.js";

/**
 * Nómina Electrónica document issuance - added alongside invoice.service.ts/
 * creditNote.service.ts/debitNote.service.ts/supportDocument.service.ts,
 * mirroring their exact create/retry/get shape (idempotency via
 * internalReference, PROCESSING → terminal status machine, xmlStore/
 * rawResponseStore persistence, contingency handling via the same generic
 * documentSend.service.ts helpers) on dian-kit's separate payroll pipeline.
 *
 * ⚠️ See `@dian-kit/core`'s payroll modules: this pipeline has not been
 * validated against DIAN's official Anexo Técnico de Nómina Electrónica or
 * a real habilitación run - verify before production use.
 */

function defaultCreateProvider(config: DianKitConfig): DianProvider {
  return env.dianSimulationMode ? new SimulatedDianProvider(config) : new DianKitProvider(config);
}

export interface CreatePayrollDocumentParams {
  companyId: string;
  internalReference: string;
  payroll: Record<string, unknown>;
  send?: SendOptions;
}

// PayrollPeriod's three dates arrive over HTTP as ISO strings, same as
// issueDate/issueTime below - but unlike those two, dian-kit.ts's
// assemblePayrollDocument passes `input.period` straight through
// unconverted, and payroll-builder.ts's formatDate() calls Date methods
// (getUTCFullYear etc.) on it. Without this conversion, every payroll
// submission throws at XML-build time ("date.getUTCFullYear is not a
// function") the first time it's actually exercised end-to-end.
function toPayrollPeriod(period: Record<string, unknown>): PayrollInput["period"] {
  return {
    ...period,
    admissionDate: new Date(period.admissionDate as string),
    settlementStartDate: new Date(period.settlementStartDate as string),
    settlementEndDate: new Date(period.settlementEndDate as string),
  } as PayrollInput["period"];
}

function toPayrollInput(raw: Record<string, unknown>, documentId: string): PayrollInput {
  return {
    ...raw,
    id: documentId,
    issueDate: new Date(raw.issueDate as string),
    issueTime: new Date(raw.issueTime as string),
    period: toPayrollPeriod(raw.period as Record<string, unknown>),
  } as PayrollInput;
}

/** Production payroll issuance: POST /api/v1/documents/payroll. Uses the company's "NE" numbering resolution - a separate DIAN authorization from invoicing's "01". */
export async function createPayrollDocument(params: CreatePayrollDocumentParams, deps: DocumentServiceDeps = {}) {
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
  const rawResponseStore = deps.rawResponseStore ?? createDefaultRawResponseStore();
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const existing = await prisma.payrollDocument.findUnique({
    where: {
      companyId_internalReference: {
        companyId: params.companyId,
        internalReference: params.internalReference,
      },
    },
    include: { certificate: true },
  });
  if (existing) {
    // See invoice.service.ts#createInvoice's identical check for the full rationale.
    if (existing.status === "PROCESSING") {
      throw new Error(
        `Payroll document ${params.internalReference} is still being processed (status=PROCESSING since ${existing.createdAt.toISOString()}) — retry shortly.`,
      );
    }
    return existing;
  }

  const { numbering, certificateId, config } = await loadDianConfig(
    { companyId: params.companyId, documentType: "NE" },
    secretStore,
  );
  const { documentId } = await claimNextNumber(numbering.id);

  const payrollRecord = await prisma.payrollDocument.create({
    data: {
      companyId: params.companyId,
      internalReference: params.internalReference,
      numberingId: numbering.id,
      certificateId,
      status: "PROCESSING",
      testSetId: params.send?.testSetId ?? null,
    },
    include: { certificate: true },
  });

  try {
    const provider = createProvider(config);
    const input = toPayrollInput(params.payroll, documentId);

    const document = await provider.createPayrollDocument(input);

    const xmlReference = payrollRecord.id;
    await xmlStore.save(xmlReference, document.signedXml);

    const outcome = await sendWithContingencyHandling(provider, document, params.send);

    if (outcome.kind === "contingency") {
      return await prisma.payrollDocument.update({
        where: { id: payrollRecord.id },
        data: {
          documentNumber: document.documentNumber,
          prefix: numbering.prefix,
          cune: document.uuid,
          xmlReference,
          status: "CONTINGENCY",
          simulated,
          issuedAt: new Date(),
          errorMessage: outcome.error.rawResponse
            ? `${outcome.error.message}\n\nDIAN response: ${outcome.error.rawResponse}`
            : outcome.error.message,
        },
        include: { certificate: true },
      });
    }

    const { response } = outcome;
    await rawResponseStore.save(xmlReference, response.rawResponse);
    return await prisma.payrollDocument.update({
      where: { id: payrollRecord.id },
      data: {
        documentNumber: document.documentNumber,
        prefix: numbering.prefix,
        cune: document.uuid,
        xmlReference,
        dianResponseReference: xmlReference,
        simulated,
        issuedAt: new Date(),
        sentAt: new Date(),
        ...computeSentStatusFields(response),
      },
      include: { certificate: true },
    });
  } catch (error) {
    await prisma.payrollDocument.update({
      where: { id: payrollRecord.id },
      data: {
        status: "ERROR",
        simulated,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

/** Retries sending a CONTINGENCY payroll document - see retryInvoiceSend in invoice.service.ts for the full rationale (identical here, different Prisma model). */
export async function retryPayrollDocumentSend(
  companyId: string,
  id: string,
  send?: SendOptions,
  deps: DocumentServiceDeps = {},
) {
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const rawResponseStore = deps.rawResponseStore ?? createDefaultRawResponseStore();
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const payroll = await prisma.payrollDocument.findFirst({ where: { id, companyId } });
  if (!payroll) {
    throw new Error(`Payroll document ${id} not found for company ${companyId}`);
  }
  const stuckWithoutTrackId = payroll.status === "SENT" && !payroll.trackId;
  if (payroll.status !== "CONTINGENCY" && !stuckWithoutTrackId) {
    throw new Error(`Payroll document ${id} is not in CONTINGENCY (status=${payroll.status}) — nothing to retry.`);
  }
  if (!payroll.xmlReference || !payroll.documentNumber || !payroll.cune) {
    throw new Error(`Payroll document ${id} is CONTINGENCY but missing xmlReference/documentNumber/cune — cannot resend.`);
  }

  const { config } = await loadDianConfig({ companyId, documentType: "NE" }, secretStore);
  const provider = createProvider(config);
  const signedXml = await xmlStore.get(payroll.xmlReference);
  const document = reconstructDocumentForResend(signedXml, payroll.documentNumber, payroll.cune);

  const outcome = await sendWithContingencyHandling(provider, document, send);

  if (outcome.kind === "contingency") {
    return await prisma.payrollDocument.update({
      where: { id: payroll.id },
      data: {
        errorMessage: outcome.error.rawResponse
          ? `${outcome.error.message}\n\nDIAN response: ${outcome.error.rawResponse}`
          : outcome.error.message,
      },
      include: { certificate: true },
    });
  }

  const { response } = outcome;
  await rawResponseStore.save(payroll.xmlReference, response.rawResponse);
  return await prisma.payrollDocument.update({
    where: { id: payroll.id },
    data: {
      simulated,
      sentAt: new Date(),
      dianResponseReference: payroll.xmlReference,
      ...computeSentStatusFields(response),
    },
    include: { certificate: true },
  });
}

export async function getPayrollDocument(companyId: string, id: string) {
  return prisma.payrollDocument.findFirst({ where: { id, companyId }, include: { certificate: true } });
}

export interface CreatePayrollAdjustmentParams {
  companyId: string;
  internalReference: string;
  payrollDocumentId: string;
  adjustmentType: "1" | "2";
  payroll: Record<string, unknown>;
  send?: SendOptions;
}

/**
 * Payroll correction (Nómina Individual de Ajuste) - always references a
 * PayrollDocument that already exists in ITCycle's own database, same
 * "derive predecessorCune from our own record, never trust the caller"
 * pattern as createCreditNote/createDebitNote.
 */
export async function createPayrollAdjustment(params: CreatePayrollAdjustmentParams, deps: DocumentServiceDeps = {}) {
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
  const rawResponseStore = deps.rawResponseStore ?? createDefaultRawResponseStore();
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const existing = await prisma.payrollAdjustment.findUnique({
    where: {
      companyId_internalReference: {
        companyId: params.companyId,
        internalReference: params.internalReference,
      },
    },
    include: { certificate: true },
  });
  if (existing) {
    if (existing.status === "PROCESSING") {
      throw new Error(
        `Payroll adjustment ${params.internalReference} is still being processed (status=PROCESSING since ${existing.createdAt.toISOString()}) — retry shortly.`,
      );
    }
    return existing;
  }

  const payrollDocument = await prisma.payrollDocument.findFirst({
    where: { id: params.payrollDocumentId, companyId: params.companyId },
  });
  if (!payrollDocument) {
    throw new Error(`Payroll document ${params.payrollDocumentId} not found for company ${params.companyId}`);
  }
  if (payrollDocument.status !== "ACCEPTED" || !payrollDocument.cune) {
    throw new Error(
      `Payroll document ${params.payrollDocumentId} is not ACCEPTED (status=${payrollDocument.status}) — an adjustment can only ` +
        "reference a payroll document DIAN has already accepted.",
    );
  }

  const { numbering, certificateId, config } = await loadDianConfig(
    { companyId: params.companyId, documentType: "NE" },
    secretStore,
  );
  const { documentId } = await claimNextNumber(numbering.id);

  const adjustmentRecord = await prisma.payrollAdjustment.create({
    data: {
      companyId: params.companyId,
      payrollDocumentId: payrollDocument.id,
      internalReference: params.internalReference,
      numberingId: numbering.id,
      certificateId,
      adjustmentType: params.adjustmentType,
      status: "PROCESSING",
      testSetId: params.send?.testSetId ?? null,
    },
    include: { certificate: true },
  });

  try {
    const provider = createProvider(config);
    const input: PayrollAdjustmentInput = {
      ...(params.payroll as object),
      id: documentId,
      issueDate: new Date(params.payroll.issueDate as string),
      issueTime: new Date(params.payroll.issueTime as string),
      period: toPayrollPeriod(params.payroll.period as Record<string, unknown>),
      adjustmentType: params.adjustmentType,
      predecessorCune: payrollDocument.cune,
    } as PayrollAdjustmentInput;

    const document = await provider.createPayrollAdjustment(input);

    const xmlReference = adjustmentRecord.id;
    await xmlStore.save(xmlReference, document.signedXml);

    const outcome = await sendWithContingencyHandling(provider, document, params.send);

    if (outcome.kind === "contingency") {
      return await prisma.payrollAdjustment.update({
        where: { id: adjustmentRecord.id },
        data: {
          documentNumber: document.documentNumber,
          prefix: numbering.prefix,
          cune: document.uuid,
          xmlReference,
          status: "CONTINGENCY",
          simulated,
          issuedAt: new Date(),
          errorMessage: outcome.error.rawResponse
            ? `${outcome.error.message}\n\nDIAN response: ${outcome.error.rawResponse}`
            : outcome.error.message,
        },
        include: { certificate: true },
      });
    }

    const { response } = outcome;
    await rawResponseStore.save(xmlReference, response.rawResponse);
    return await prisma.payrollAdjustment.update({
      where: { id: adjustmentRecord.id },
      data: {
        documentNumber: document.documentNumber,
        prefix: numbering.prefix,
        cune: document.uuid,
        xmlReference,
        dianResponseReference: xmlReference,
        simulated,
        issuedAt: new Date(),
        sentAt: new Date(),
        ...computeSentStatusFields(response),
      },
      include: { certificate: true },
    });
  } catch (error) {
    await prisma.payrollAdjustment.update({
      where: { id: adjustmentRecord.id },
      data: {
        status: "ERROR",
        simulated,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function getPayrollAdjustment(companyId: string, id: string) {
  return prisma.payrollAdjustment.findFirst({ where: { id, companyId }, include: { certificate: true } });
}
