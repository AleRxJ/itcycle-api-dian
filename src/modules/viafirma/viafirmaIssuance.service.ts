import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "../../infrastructure/prisma.js";
import {
  generateKeyPairAndCsr,
  ViafirmaCertificateProvider,
  type ViafirmaCsrSubject,
  type ViafirmaProfileKind,
  type ViafirmaProviderConfig,
} from "../../providers/certificates/ViafirmaCertificateProvider.js";
import type { CertificateProviderStatusResult } from "../../providers/certificates/CertificateProvider.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { env } from "../../shared/env.js";

/**
 * Fase 5/6/7 orchestration for Viafirma issuance — the counterpart to
 * `../firmapass/firmaPassIssuance.service.ts`, but shaped very differently
 * because the two providers' flows don't share a common issuance shape
 * (see the file-level doc on `../../providers/certificates/CertificateProvider.ts`).
 * Real finalization (P7B download + PKCS12 assembly once Viafirma reaches
 * `Generated_Not_Downloaded`) happens asynchronously in
 * `../../jobs/viafirmaIssuance.job.ts`, same split as FirmaPass.
 */

function getViafirmaConfig(): ViafirmaProviderConfig {
  if (!env.viafirmaConsumerKey || !env.viafirmaConsumerSecret) {
    throw new Error("VIAFIRMA_CONSUMER_KEY / VIAFIRMA_CONSUMER_SECRET are not configured");
  }
  return {
    baseUrl: env.viafirmaBaseUrl,
    downloadBaseUrl: env.viafirmaDownloadBaseUrl ?? "",
    consumerKey: env.viafirmaConsumerKey,
    consumerSecret: env.viafirmaConsumerSecret,
    ra: env.viafirmaRa,
  };
}

function getProvider(): ViafirmaCertificateProvider {
  return new ViafirmaCertificateProvider(getViafirmaConfig());
}

/**
 * `submittedData` is the (non-secret) form data the caller submitted,
 * flattened to the same shape Ohnix's UI form uses (subject fields alongside
 * identityType/organizationType/emailCertificate) rather than mirroring
 * `CreateViafirmaRequestParams`'s nested `subject` wrapper. Persisted purely
 * so the applicant can review "what did I actually send" later (Ohnix's own
 * UI has no other record of it — the CSR itself is built and discarded
 * in-process, never stored). Never includes the private key or CSR bytes;
 * those live only in the CertificateSecretStore.
 */
type ViafirmaSubmittedData = ViafirmaCsrSubject & {
  identityType: "IDC" | "PAS";
  emailCertificate: string;
  organizationType?: "RM" | "PROP" | "RUNEOL" | "RNT" | "ESAL" | "ESOL" | "JUEGOS" | "EXTRANJERAS";
};

interface ViafirmaCertificateMetadata {
  publicId: string;
  submittedData: ViafirmaSubmittedData;
}

export interface ViafirmaCertificateSummary {
  id: string;
  certificateIdentifier: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  submittedData: ViafirmaCertificateMetadata["submittedData"] | null;
}

/**
 * Read-only, no-network projection of this company's Viafirma certificates
 * (newest first) — how the UI recovers "do I already have an in-progress or
 * active Viafirma certificate" after a page reload, since `certificateId`
 * isn't derivable from anything Viafirma itself hands back. Mirrors
 * `../admin/admin.service.ts`'s `getFirmaPassStatus` (same provider-scoped
 * DB read, no live status polling — see `getViafirmaCertificateStatus` for that).
 */
export async function listViafirmaCertificates(companyId: string): Promise<ViafirmaCertificateSummary[]> {
  const certificates = await prisma.certificate.findMany({
    where: { companyId, provider: "viafirma" },
    orderBy: { createdAt: "desc" },
  });
  return certificates.map((c) => {
    const metadata = c.providerMetadata as Partial<ViafirmaCertificateMetadata> | null;
    return {
      id: c.id,
      certificateIdentifier: c.certificateIdentifier,
      status: c.status,
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
      submittedData: metadata?.submittedData ?? null,
    };
  });
}

async function requireViafirmaCertificate(companyId: string, certificateId: string) {
  const certificate = await prisma.certificate.findFirst({
    where: { id: certificateId, companyId, provider: "viafirma" },
  });
  if (!certificate) {
    throw new Error(`Viafirma certificate ${certificateId} not found for company ${companyId}`);
  }
  return certificate;
}

export interface CreateViafirmaRequestParams {
  companyId: string;
  profileKind: ViafirmaProfileKind;
  subject: ViafirmaCsrSubject;
  identityType: "IDC" | "PAS";
  countryCode: string;
  identity: string;
  emailCertificate: string;
  /** Required for FE-PJ (§2.3.2.3); ignored for FE-PN. "RM" is the doc's own recommended default. */
  organizationType?: "RM" | "PROP" | "RUNEOL" | "RNT" | "ESAL" | "ESOL" | "JUEGOS" | "EXTRANJERAS";
  /**
   * Must be `true` - CEA-3.0-07 art. 10.11.1.e (ONAC digital-certification
   * regulation) requires demonstrable acceptance of the profile's terms and
   * conditions before a request can be submitted. The caller's own form is
   * expected to block submission on this already; this is the
   * can't-be-bypassed enforcement of that same rule.
   */
  termsAccepted: boolean;
}

export interface CreateViafirmaRequestResult {
  certificateId: string;
  codRequest: string;
}

/**
 * Starts a brand-new Viafirma issuance: generates the keypair/CSR locally,
 * stashes the private key into the secret store BEFORE ever calling
 * Viafirma (so it's never lost even if the create-request call fails
 * partway through), submits the CSR, and records a `Certificate` row
 * (status INACTIVE, `expiresAt` null — real value known once
 * `viafirmaIssuance.job.ts` finalizes it).
 *
 * `codProfile` is resolved from `getAvailableProfiles()` on every call
 * rather than cached/hardcoded — deliberate, per §2.3.1's own warning that
 * profile codes differ between Sandbox and Production and must be
 * re-fetched, and this runs once per certificate issuance (not a hot path).
 */
export async function createViafirmaRequest(params: CreateViafirmaRequestParams): Promise<CreateViafirmaRequestResult> {
  if (!params.termsAccepted) {
    throw new Error("termsAccepted must be true - CEA-3.0-07 art. 10.11.1.e requires accepting the profile's terms before requesting a certificate");
  }

  const provider = getProvider();

  const profiles = await provider.getAvailableProfiles();
  const wantedType = params.profileKind === "FE-PJ" ? "CORPORATIVO" : "INDIVIDUAL";
  const profile = profiles.find((p) => p.type === wantedType);
  if (!profile) {
    throw new Error(`No Viafirma profile of type ${wantedType} is available for RA "${env.viafirmaRa}" in this environment`);
  }

  const { csrPem, privateKeyPem } = generateKeyPairAndCsr(params.subject);
  const csrBase64 = Buffer.from(csrPem, "utf-8").toString("base64");

  const secretStore = createDefaultCertificateSecretStore();
  const secretReference = randomUUID();
  // Bare PEM private key, not yet a real PKCS12 (empty password is the
  // documented "not finalized yet" sentinel) — same in-between-state
  // discipline `firmaPassIssuance.service.ts`'s `confirmValidation` follows
  // for FirmaPass's `private_key_pem`. Saved BEFORE the network call below
  // so a failed/interrupted request never loses the only copy of this key.
  await secretStore.save(secretReference, { p12: Buffer.from(privateKeyPem, "utf-8"), password: "" });

  let created;
  try {
    created = await provider.createRequestFromCsr(
      params.profileKind === "FE-PJ"
        ? {
            profileKind: "FE-PJ",
            identityType: params.identityType,
            countryCode: params.countryCode,
            identity: params.identity,
            ra: env.viafirmaRa,
            codProfile: profile.code,
            emailCertificate: params.emailCertificate,
            organizationType: params.organizationType ?? "RM",
            csr: csrBase64,
          }
        : {
            profileKind: "FE-PN",
            identityType: params.identityType,
            countryCode: params.countryCode,
            identity: params.identity,
            ra: env.viafirmaRa,
            codProfile: profile.code,
            emailCertificate: params.emailCertificate,
            csr: csrBase64,
          },
    );
  } catch (error) {
    // The request never reached Viafirma, or was rejected before any
    // codRequest was issued — the private key just stashed above is now
    // orphaned. Clean it up rather than leaking an unreferenced secret.
    await secretStore.delete(secretReference);
    throw error;
  }

  const submittedData: ViafirmaSubmittedData = {
    ...params.subject,
    identityType: params.identityType,
    emailCertificate: params.emailCertificate,
    ...(params.profileKind === "FE-PJ" ? { organizationType: params.organizationType ?? "RM" } : {}),
  };

  const certificate = await prisma.certificate.create({
    data: {
      companyId: params.companyId,
      provider: "viafirma",
      certificateIdentifier: created.codRequest,
      secretReference,
      expiresAt: null,
      status: "INACTIVE",
      providerMetadata: { publicId: created.publicId, submittedData } satisfies ViafirmaCertificateMetadata as unknown as Prisma.InputJsonValue,
    },
  });

  return { certificateId: certificate.id, codRequest: created.codRequest };
}

/**
 * Terms-and-conditions URL for a profile kind, straight from Viafirma's own
 * `getAvailableProfiles()` (§2.3.1) - never cached beyond the request, per
 * the doc's own warning to re-check this periodically rather than treat it
 * as a fixed value. Used to render the mandatory acceptance checkbox
 * (§3.4 / CEA-3.0-07 art. 10.11.1.e) before a request can be submitted.
 */
export async function getViafirmaProfileTerms(profileKind: ViafirmaProfileKind): Promise<{ terms: string }> {
  const provider = getProvider();
  const profiles = await provider.getAvailableProfiles();
  const wantedType = profileKind === "FE-PJ" ? "CORPORATIVO" : "INDIVIDUAL";
  const profile = profiles.find((p) => p.type === wantedType);
  if (!profile) {
    throw new Error(`No Viafirma profile of type ${wantedType} is available for RA "${env.viafirmaRa}" in this environment`);
  }
  return { terms: profile.terms };
}

export interface ViafirmaCertificateStatusResult extends CertificateProviderStatusResult {
  certificateId: string;
}

/** Live status projection for one certificate — see `InternalCertificateStatus` for the vocabulary Ohnix's UI should key off. */
export async function getViafirmaCertificateStatus(params: {
  companyId: string;
  certificateId: string;
}): Promise<ViafirmaCertificateStatusResult> {
  const certificate = await requireViafirmaCertificate(params.companyId, params.certificateId);
  const status = await getProvider().getStatus(certificate.certificateIdentifier);
  return { certificateId: certificate.id, ...status };
}

/** GET KYC link (§2.3.8) — only meaningful while status === "accreditation"; Viafirma itself 400s (`link_not_generated`) otherwise. */
export async function getViafirmaKycLink(params: { companyId: string; certificateId: string }): Promise<string> {
  const certificate = await requireViafirmaCertificate(params.companyId, params.certificateId);
  return getProvider().getKycLink(certificate.certificateIdentifier);
}

export interface UploadViafirmaDocumentParams {
  companyId: string;
  certificateId: string;
  name: string;
  base64: string;
}

/** Attaches supporting documentation (§2.3.7) — used while status === "docRequired". */
export async function uploadViafirmaDocument(params: UploadViafirmaDocumentParams) {
  const certificate = await requireViafirmaCertificate(params.companyId, params.certificateId);
  return getProvider().uploadDocument(certificate.certificateIdentifier, { name: params.name, base64: params.base64 });
}

export async function listViafirmaDocuments(params: { companyId: string; certificateId: string }) {
  const certificate = await requireViafirmaCertificate(params.companyId, params.certificateId);
  return getProvider().listUploadedDocuments(certificate.certificateIdentifier);
}

/**
 * Revokes a Viafirma certificate. `RecordStatus` only models
 * ACTIVE/INACTIVE (no dedicated REVOKED value) — matches how FirmaPass
 * certificates are tracked today; revocation lands the row in INACTIVE,
 * same as an issuance that never completed.
 */
export async function revokeViafirmaCertificate(params: { companyId: string; certificateId: string; reason?: string }) {
  const certificate = await requireViafirmaCertificate(params.companyId, params.certificateId);
  const result = await getProvider().revoke(certificate.certificateIdentifier, params.reason);
  await prisma.certificate.update({ where: { id: certificate.id }, data: { status: "INACTIVE" } });
  return result;
}
