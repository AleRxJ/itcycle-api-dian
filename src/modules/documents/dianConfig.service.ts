import type { DianKitConfig, Party } from "@dian-kit/sdk-node";

import { prisma } from "../../infrastructure/prisma.js";
import type { CertificateSecretStore } from "../../providers/certificates/CertificateSecretStore.js";

/**
 * DIAN document type codes this module claims numbering for. Kept as a
 * plain union (not the full DIAN code list in dian-engine's DocumentType
 * constant) because only these four are wired up on the ITCycle side.
 */
export type NumberedDocumentType = "01" | "91" | "92" | "05";

export interface LoadDianConfigParams {
  companyId: string;
  documentType: NumberedDocumentType;
}

export interface LoadedDianConfig {
  companyNit: string;
  companyName: string;
  numbering: { id: string; prefix: string };
  certificateId: string;
  config: DianKitConfig;
}

/**
 * Loads everything a DianProvider call needs for one company/document type:
 * DianConfiguration, an ACTIVE NumberingResolution scoped to that
 * documentType, an ACTIVE Certificate, and the certificate's actual secret
 * (via the injected store — never read directly from the database).
 *
 * Shared by invoice/creditNote/debitNote services so each one doesn't
 * re-derive DianKitConfig on its own. Deliberately NOT used by
 * test-invoice.service.ts (see docs/dian/sandbox-tests.md) — that dev-only
 * path is left untouched to avoid any risk to its verified Sandbox run.
 */
export async function loadDianConfig(
  params: LoadDianConfigParams,
  secretStore: CertificateSecretStore,
): Promise<LoadedDianConfig> {
  const now = new Date();
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: params.companyId },
    include: { dianConfiguration: true },
  });
  const dianConfiguration = company.dianConfiguration;
  if (!dianConfiguration || !dianConfiguration.supplierProfile) {
    throw new Error(`Company ${params.companyId} has no active DianConfiguration/supplierProfile`);
  }

  // currentNumber <= endNumber can't be expressed as a Prisma `where` filter
  // (it compares two columns of the same row), so date range/status are
  // filtered in the query and exhaustion is filtered in JS below. Ordered by
  // createdAt desc so the most recently provisioned match wins when a
  // company has more than one qualifying row (e.g. right after a renewal) —
  // matches admin.service.ts's getDianReadiness, which must agree with this
  // function on which row is "the" active one.
  const candidateResolutions = await prisma.numberingResolution.findMany({
    where: {
      companyId: params.companyId,
      documentType: params.documentType,
      status: "ACTIVE",
      startDate: { lte: now },
      endDate: { gte: now },
    },
    orderBy: { createdAt: "desc" },
  });
  const numbering = candidateResolutions.find((resolution) => resolution.currentNumber <= resolution.endNumber);
  if (!numbering) {
    throw new Error(
      `Company ${params.companyId} has no ACTIVE, currently-valid, non-exhausted NumberingResolution for documentType="${params.documentType}". ` +
        "Provision one (e.g. via scripts/seed-test-company.ts or Prisma Studio) before issuing this document type.",
    );
  }

  const candidateCertificates = await prisma.certificate.findMany({
    where: { companyId: params.companyId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
  const certificate = candidateCertificates.find((c) => !c.expiresAt || c.expiresAt >= now);
  if (!certificate) {
    throw new Error(`Company ${params.companyId} has no ACTIVE, non-expired Certificate.`);
  }

  const secret = await secretStore.get(certificate.secretReference);

  const config: DianKitConfig = {
    certificate: secret.p12,
    certificatePassword: secret.password,
    environment: dianConfiguration.environment === "PRODUCTION" ? "1" : "2",
    supplier: dianConfiguration.supplierProfile as unknown as Party,
    software: {
      id: dianConfiguration.softwareId,
      pin: dianConfiguration.softwarePin,
      providerNit: company.nit,
      providerName: company.name,
    },
    numbering: {
      authorizationNumber: numbering.resolutionNumber,
      prefix: numbering.prefix,
      startNumber: numbering.startNumber,
      endNumber: numbering.endNumber,
      startDate: numbering.startDate,
      endDate: numbering.endDate,
      technicalKey: dianConfiguration.technicalKey ?? undefined,
    },
  };

  return {
    companyNit: company.nit,
    companyName: company.name,
    numbering: { id: numbering.id, prefix: numbering.prefix },
    certificateId: certificate.id,
    config,
  };
}

/**
 * Atomically claims the next document number from a NumberingResolution,
 * so the caller (an HTTP request body) never gets to pick its own document
 * id — only test-invoice's dev-only flow still allows that. Numbers are
 * never reused: if the caller's request later turns out to be a duplicate
 * (idempotent replay), the claimed number is simply skipped, which DIAN
 * permits (gaps are fine, reuse is not).
 */
export async function claimNextNumber(numberingId: string): Promise<{ documentId: string; number: number }> {
  return prisma.$transaction(async (tx) => {
    const numbering = await tx.numberingResolution.findUniqueOrThrow({ where: { id: numberingId } });
    if (numbering.currentNumber > numbering.endNumber) {
      throw new Error(
        `NumberingResolution ${numbering.id} is exhausted (range ${numbering.startNumber}-${numbering.endNumber}). ` +
          "A new DIAN numbering resolution must be requested and provisioned.",
      );
    }

    const claimed = numbering.currentNumber;
    await tx.numberingResolution.update({
      where: { id: numberingId },
      data: { currentNumber: claimed + 1 },
    });

    return { documentId: `${numbering.prefix}${claimed}`, number: claimed };
  });
}
