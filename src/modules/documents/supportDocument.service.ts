import type { DianKitConfig, SendOptions, SupportDocumentInput } from "@dian-kit/sdk-node";

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

export interface CreateSupportDocumentParams {
  companyId: string;
  internalReference: string;
  document: Record<string, unknown>;
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
 * Production Documento Soporte issuance: POST /api/v1/documents/support-documents.
 *
 * Same flow as invoice.service.ts#createInvoice, claiming the next number
 * from the company's ACTIVE NumberingResolution for documentType "05".
 *
 * IMPORTANT — party roles: `params.document.customer` must hold the
 * real-world SELLER's identity (the non-obligated third party). The
 * `supplier` side of the resulting XML is always the ITCycle-registered
 * company (injected from DianKitConfig), which in real-world terms is the
 * BUYER for this document type — see SupportDocumentInput's doc comment in
 * @dian-kit/sdk-node for the full explanation. Nothing here validates that
 * the caller got this right.
 */
export async function createSupportDocument(params: CreateSupportDocumentParams, deps: DocumentServiceDeps = {}) {
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const existing = await prisma.supportDocument.findUnique({
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
    { companyId: params.companyId, documentType: "05" },
    secretStore,
  );
  const { documentId } = await claimNextNumber(numbering.id);

  const supportDocumentRecord = await prisma.supportDocument.create({
    data: {
      companyId: params.companyId,
      internalReference: params.internalReference,
      numberingId: numbering.id,
      certificateId,
      status: "PROCESSING",
      testSetId: params.send?.testSetId ?? null,
    },
  });

  try {
    const provider = createProvider(config);
    const supportDocumentInput = toSupportDocumentInput(params.document, documentId);

    // Building/signing is entirely local (dian-kit) — a failure here means
    // there is no document to deliver, so it stays ERROR (below, in the
    // outer catch). Only *sending* to DIAN can turn into a contingencia.
    const document = await provider.createSupportDocument(supportDocumentInput);

    // Persisted before attempting send(): if DIAN is unreachable, this is
    // exactly the XML that must be re-sent later via retry-send — dian-kit's
    // XAdES-EPES signature embeds a timestamp, so re-signing would produce a
    // different document, not a retry of the same one.
    const xmlReference = supportDocumentRecord.id;
    await xmlStore.save(xmlReference, document.signedXml);

    const outcome = await sendWithContingencyHandling(provider, document, params.send);

    if (outcome.kind === "contingency") {
      return await prisma.supportDocument.update({
        where: { id: supportDocumentRecord.id },
        data: {
          documentNumber: document.documentNumber,
          prefix: numbering.prefix,
          cufe: document.uuid,
          xmlReference,
          status: "CONTINGENCY",
          simulated,
          issuedAt: new Date(),
          errorMessage: outcome.error.rawResponse
            ? `${outcome.error.message}\n\nDIAN response: ${outcome.error.rawResponse}`
            : outcome.error.message,
        },
      });
    }

    const { response } = outcome;
    return await prisma.supportDocument.update({
      where: { id: supportDocumentRecord.id },
      data: {
        documentNumber: document.documentNumber,
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
    await prisma.supportDocument.update({
      where: { id: supportDocumentRecord.id },
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
 * Retries sending a CONTINGENCY support document to DIAN — reuses the exact
 * previously-signed XML (never regenerated) and the same document number and
 * CUDE the seller relationship already recorded. Stays CONTINGENCY if DIAN
 * is still unreachable; transitions to ACCEPTED/REJECTED once DIAN responds.
 */
export async function retrySupportDocumentSend(
  companyId: string,
  id: string,
  send?: SendOptions,
  deps: DocumentServiceDeps = {},
) {
  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const createProvider = deps.createProvider ?? defaultCreateProvider;
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();
  const simulated = !deps.createProvider && env.dianSimulationMode;

  const supportDocument = await prisma.supportDocument.findFirst({ where: { id, companyId } });
  if (!supportDocument) {
    throw new Error(`SupportDocument ${id} not found for company ${companyId}`);
  }
  if (supportDocument.status !== "CONTINGENCY") {
    throw new Error(`SupportDocument ${id} is not in CONTINGENCY (status=${supportDocument.status}) — nothing to retry.`);
  }
  if (!supportDocument.xmlReference || !supportDocument.documentNumber || !supportDocument.cufe) {
    throw new Error(`SupportDocument ${id} is CONTINGENCY but missing xmlReference/documentNumber/cufe — cannot resend.`);
  }

  const { config } = await loadDianConfig({ companyId, documentType: "05" }, secretStore);
  const provider = createProvider(config);
  const signedXml = await xmlStore.get(supportDocument.xmlReference);
  const document = reconstructDocumentForResend(signedXml, supportDocument.documentNumber, supportDocument.cufe);

  const outcome = await sendWithContingencyHandling(provider, document, send);

  if (outcome.kind === "contingency") {
    return await prisma.supportDocument.update({
      where: { id: supportDocument.id },
      data: {
        errorMessage: outcome.error.rawResponse
          ? `${outcome.error.message}\n\nDIAN response: ${outcome.error.rawResponse}`
          : outcome.error.message,
      },
    });
  }

  const { response } = outcome;
  return await prisma.supportDocument.update({
    where: { id: supportDocument.id },
    data: {
      status: response.isValid ? "ACCEPTED" : "REJECTED",
      simulated,
      sentAt: new Date(),
      acceptedAt: response.isValid ? new Date() : null,
      errorMessage: response.errors?.map((e) => e.description).join("; ") || null,
    },
  });
}

export async function getSupportDocument(companyId: string, id: string) {
  return prisma.supportDocument.findFirst({ where: { id, companyId } });
}

/**
 * Converts the JSON request body into dian-kit's SupportDocumentInput shape,
 * injecting the server-claimed document id and stripping any `id` the
 * caller may have sent. Same shaping as invoice.service.ts#toInvoiceInput.
 */
function toSupportDocumentInput(raw: Record<string, unknown>, documentId: string): SupportDocumentInput {
  return {
    ...raw,
    id: documentId,
    issueDate: new Date(raw.issueDate as string),
    issueTime: new Date(raw.issueTime as string),
  } as SupportDocumentInput;
}
