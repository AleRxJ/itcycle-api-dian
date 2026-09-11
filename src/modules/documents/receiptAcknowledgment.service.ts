import { loadP12, signXml } from "@dian-kit/core";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";
import type { DocumentXmlStore } from "../../providers/documents/DocumentXmlStore.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { createDefaultDocumentXmlStore } from "../../shared/documentXmlStore.js";
import { env } from "../../shared/env.js";
import { buildReceiptAcknowledgmentXmlStub } from "./receiptAcknowledgment.xml.js";

export type ReceiptAcknowledgmentEventType = "ACUSE_RECIBO" | "RECIBO_BIEN" | "ACEPTACION_EXPRESA" | "RECLAMO";

export interface CreateReceiptAcknowledgmentParams {
  companyId: string;
  internalReference: string;
  eventType: ReceiptAcknowledgmentEventType;
  referencedCufe: string;
  referencedInvoiceId?: string;
  responseCode?: string;
  description?: string;
}

export interface ReceiptAcknowledgmentDeps {
  secretStore?: CertificateSecretStore;
  xmlStore?: DocumentXmlStore;
}

const DEFAULT_DESCRIPTION: Record<ReceiptAcknowledgmentEventType, string> = {
  ACUSE_RECIBO: "Acuse de recibo de la factura electrónica",
  RECIBO_BIEN: "Recibo del bien y/o servicio",
  ACEPTACION_EXPRESA: "Aceptación expresa de la factura electrónica",
  RECLAMO: "Reclamo de la factura electrónica",
};

/**
 * Blocks the real-DIAN path by construction, not just by leaving it
 * untested - see receiptAcknowledgment.xml.ts's own module doc comment for
 * why: the exact ApplicationResponse XML structure, DIAN's ResponseCode
 * catalogue, and the real SOAP operation for these events are all unknown
 * pending RADIAN's technical annex (Resolución 000012 de 2021). Called as
 * the very first line of createReceiptAcknowledgment, before any
 * certificate is even loaded, so a misconfigured production environment
 * fails loudly and immediately.
 */
function assertSimulationOnly(): void {
  if (!env.dianSimulationMode) {
    throw new Error(
      "Receipt acknowledgment events (acuse/recepción/aceptación/reclamo) are not yet " +
        "supported against real DIAN - the RADIAN technical annex (Resolución 000012 de 2021) " +
        "has not been verified against this implementation. Set DIAN_SIMULATION_MODE=true to " +
        "exercise this flow, or wait for the Phase 2 real-DIAN implementation.",
    );
  }
}

/**
 * Lean certificate-only loader - the ApplicationResponse family doesn't
 * consume a DIAN numbering range, so this deliberately does NOT reuse
 * loadDianConfig (which also resolves a NumberingResolution this document
 * type has no use for). Copies the same ACTIVE/non-expired/
 * certificateProviderOverride-aware selection dianConfig.service.ts#loadDianConfig
 * uses, so the two never disagree about which certificate is "the" active one.
 */
async function loadActiveCertificateForCompany(
  companyId: string,
  secretStore: CertificateSecretStore,
): Promise<{ certificateId: string; certificatePem: ReturnType<typeof loadP12>; company: { id: string; nit: string; dv: string; name: string } }> {
  const now = new Date();
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });

  const candidateCertificates = await prisma.certificate.findMany({
    where: { companyId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
  const eligibleCertificates = company.certificateProviderOverride
    ? candidateCertificates.filter((c) => c.provider === company.certificateProviderOverride)
    : candidateCertificates;
  const certificate = eligibleCertificates.find((c) => !c.expiresAt || c.expiresAt >= now);
  if (!certificate) {
    throw new Error(
      company.certificateProviderOverride
        ? `Company ${companyId} has no ACTIVE, non-expired Certificate from provider "${company.certificateProviderOverride}" (its chosen certificateProviderOverride).`
        : `Company ${companyId} has no ACTIVE, non-expired Certificate.`,
    );
  }

  const secret = await secretStore.get(certificate.secretReference);
  const certificatePem = loadP12(secret.p12, secret.password);

  return {
    certificateId: certificate.id,
    certificatePem,
    company: { id: company.id, nit: company.nit, dv: company.dv, name: company.name },
  };
}

/**
 * Phase 1: buyer-side RADIAN acknowledgment event, SIMULATION ONLY - builds
 * and signs a real (well-formed, genuinely-signed) XML document locally, but
 * never actually transmits it to DIAN (there is no real DianProvider path
 * for this document type at all - see this module's own callers/doc
 * comments for why extending the shared DianProvider interface was
 * rejected). The "send" step is an inline canned-accept, not a network call.
 */
export async function createReceiptAcknowledgment(
  params: CreateReceiptAcknowledgmentParams,
  deps: ReceiptAcknowledgmentDeps = {},
) {
  assertSimulationOnly();

  const secretStore = deps.secretStore ?? createDefaultCertificateSecretStore();
  const xmlStore = deps.xmlStore ?? createDefaultDocumentXmlStore();

  const existing = await prisma.receiptAcknowledgment.findUnique({
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
        `Receipt acknowledgment ${params.internalReference} is still being processed (status=PROCESSING since ${existing.createdAt.toISOString()}) — retry shortly.`,
      );
    }
    // Idempotent replay: never re-sign/re-"send" the same internalReference.
    return existing;
  }

  const { certificateId, certificatePem, company } = await loadActiveCertificateForCompany(params.companyId, secretStore);

  const record = await prisma.receiptAcknowledgment.create({
    data: {
      companyId: params.companyId,
      certificateId,
      internalReference: params.internalReference,
      eventType: params.eventType,
      referencedCufe: params.referencedCufe,
      referencedInvoiceId: params.referencedInvoiceId ?? null,
      responseCode: params.responseCode ?? null,
      status: "PROCESSING",
      simulated: true,
    },
    include: { certificate: true },
  });

  try {
    const issueDateTime = new Date();
    const unsignedXml = buildReceiptAcknowledgmentXmlStub({
      id: record.id,
      issueDateTime,
      senderParty: { nit: company.nit, dv: company.dv, name: company.name },
      // The referenced supplier is only known here by its invoice/CUFE
      // reference, not a full Party - see this file's own limitation note
      // in the XML builder for why a fuller Party shape isn't attempted yet.
      receiverParty: { identification: params.referencedInvoiceId ?? "", name: "" },
      referencedCufe: params.referencedCufe,
      referencedInvoiceId: params.referencedInvoiceId,
      responseCode: params.responseCode ?? "",
      description: params.description ?? DEFAULT_DESCRIPTION[params.eventType],
    });

    const { signedXml } = await signXml({ xml: unsignedXml, certificate: certificatePem, signerRole: "buyer" });

    const xmlReference = record.id;
    await xmlStore.save(xmlReference, signedXml);

    // Inline simulated "send" - there is no real DianProvider.send() path
    // for this document type in Phase 1 (see assertSimulationOnly's doc
    // comment). Always accepts immediately; CONTINGENCY is structurally
    // unreachable this phase since nothing can time out or be rejected.
    return await prisma.receiptAcknowledgment.update({
      where: { id: record.id },
      data: {
        xmlReference,
        status: "ACCEPTED",
        issuedAt: issueDateTime,
        sentAt: issueDateTime,
        acceptedAt: issueDateTime,
      },
      include: { certificate: true },
    });
  } catch (error) {
    await prisma.receiptAcknowledgment.update({
      where: { id: record.id },
      data: {
        status: "ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function getReceiptAcknowledgment(companyId: string, id: string) {
  return prisma.receiptAcknowledgment.findFirst({ where: { id, companyId }, include: { certificate: true } });
}
