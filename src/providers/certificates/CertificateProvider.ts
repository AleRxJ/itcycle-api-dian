/**
 * ITCycle's abstraction over an external digital-certificate authority
 * (FirmaPass today, Viafirma Colombia as of this file — see
 * {@link FirmaPassCertificateProvider} / {@link ViafirmaCertificateProvider}).
 *
 * Unlike {@link DianProvider} (../dian/DianProvider.ts), this interface is
 * DELIBERATELY narrow. DianProvider works because every engine behind it
 * performs the exact same conceptual operations (build/sign/send a UBL
 * document) with the exact same inputs — a real swap-in-place abstraction.
 * Certificate authorities are not that homogeneous: FirmaPass issues a
 * certificate from an identity-validation UUID that already carries
 * RUT/document uploads and a `confirmar` step with no CSR involved anywhere,
 * while Viafirma issues one from a client-generated CSR plus a completely
 * different KYC/accreditation/document-upload/P7B-download shape (see
 * "Uso del API para perfiles PKCS#10 v1.7" — RA Viafirma Colombia). Forcing
 * both behind one fat interface would mean inventing a fake generic
 * `step(name, payload)` shape that throws away type safety and hides real
 * differences the rest of the system needs to reason about — exactly what
 * the product brief means by "no intentar convertir FirmaPass a PKCS10" /
 * "cada provider debe encapsular su propia lógica".
 *
 * So: only the operations that are genuinely universal across every
 * certificate authority live here — status projection and revocation, the
 * two things {@link CertificateProviderRegistry} and any provider-agnostic
 * dashboard/status code need. Starting a NEW issuance is intentionally NOT
 * part of this interface — each provider exposes its own richly-typed
 * issuance methods (e.g. `ViafirmaCertificateProvider.createRequestFromCsr`,
 * `FirmaPassCertificateProvider.confirmValidation`), and the caller that
 * begins an issuance already knows — via
 * {@link CertificateProviderRegistry.choosePrimaryProvider} — which concrete
 * provider it is driving.
 */

/**
 * Internal status vocabulary, provider-agnostic. Every provider's native
 * states map into one of these — see
 * `ViafirmaCertificateProvider.mapViafirmaStatus` and
 * `FirmaPassCertificateProvider.mapFirmaPassStatus` for the mapping tables.
 * Ohnix's UI is expected to key its copy off THIS enum, never off a raw
 * provider status string.
 */
export type InternalCertificateStatus =
  /** Request accepted by the provider, automated/manual review in progress. No action possible from Ohnix or the user right now. */
  | "pending_provider_review"
  /** The subscriber must complete an identity-verification (KYC) step before the provider can continue. */
  | "awaiting_identity_verification"
  /** The provider is processing a submitted identity verification. Transient — if it never leaves this state, it needs provider-side support intervention (see Viafirma `accreditation_check` semantics). */
  | "verifying_identity"
  /** The provider rejected the identity verification (or the RUT/RUES/organization check). Terminal for THIS request — does not by itself mean the provider is unavailable (see CertificateProviderRegistry fallback policy). */
  | "identity_rejected"
  /** The provider is asking for additional supporting documentation before it can proceed. */
  | "awaiting_documents"
  /** Documentation was submitted and is pending provider review. */
  | "documents_under_review"
  /** The certificate has been issued by the CA and is ready to be finalized/downloaded (P7B for Viafirma, PEM+cert for FirmaPass). */
  | "issued_ready_to_finalize"
  /** The certificate has been fully finalized (downloaded/assembled into a usable PKCS12) and is the active certificate for the company. */
  | "active"
  /** Issuance failed for a reason that is NOT a rejection of the applicant's identity/data (e.g. a CA-side signing error). Provider-specific `failureReason` should always be set alongside this. */
  | "issuance_failed"
  /** The certificate was revoked (by the subscriber, an operator, or automatically on expiry-adjacent policy). */
  | "revoked"
  /** The certificate reached the end of its validity period. Distinct from "revoked" (an explicit action) even though both mean the certificate can no longer be used to sign. */
  | "expired";

/**
 * True for any status that means THIS specific request/applicant was
 * rejected or failed for a reason intrinsic to the request (identity
 * mismatch, invalid RUES/NIT, rejected documents, a CA-side signing
 * failure on this CSR) — never true for a transport/technical failure.
 * Covers both "identity_rejected" (e.g. Viafirma's `accreditation_rejected`)
 * and "issuance_failed" (e.g. Viafirma's `rues_error`/`fail`) — the product
 * brief gives both kinds as explicit non-fallback examples ("Viafirma
 * rechaza identidad → NO FirmaPass", "Viafirma rechaza RUES → NO
 * FirmaPass"). {@link CertificateProviderRegistry} MUST NOT fall back to a
 * secondary provider when this is true: "una solicitud rechazada no
 * significa que el proveedor esté caído", and creating a second request
 * with a different provider for the same applicant risks duplicate/
 * parallel certificates. Fallback eligibility is decided separately, from
 * a THROWN {@link CertificateProviderTechnicalError} at request-creation
 * time — never from a status returned here.
 */
export function isFunctionalRejection(status: InternalCertificateStatus): boolean {
  return status === "identity_rejected" || status === "issuance_failed";
}

export interface CertificateProviderStatusResult {
  internalStatus: InternalCertificateStatus;
  /** The provider's own raw status code/string, kept for support/debugging — never shown to the end user as-is. */
  providerStatus: string;
  /** True when the user (not Ohnix, not the provider) is the one who must act next — e.g. complete KYC, upload a document. */
  requiresUserAction: boolean;
  /** True when Ohnix/support intervention is expected (a state that shouldn't self-resolve — e.g. Viafirma's `accreditation_check` not clearing). */
  requiresSupportIntervention: boolean;
  /** Set only when internalStatus is "issuance_failed" or "identity_rejected". Free text, provider-specific, safe to log but not guaranteed safe to show verbatim to the end user. */
  failureReason?: string;
}

export interface CertificateProviderRevocationResult {
  revoked: boolean;
  /** Provider-specific confirmation/reference for the revocation, if any (e.g. FirmaPass's `revocationRequestCode`). */
  providerReference?: string;
}

export interface CertificateProvider {
  /** Machine-readable id — matches `Certificate.provider` in prisma/schema.prisma (a free-text column, no enum, no migration needed to add "viafirma"). */
  readonly name: string;

  /**
   * Projects the provider's current state for one certificate onto
   * {@link InternalCertificateStatus}. `providerRequestId` is whatever this
   * provider itself used as `certificateIdentifier` when the `Certificate`
   * row was created (FirmaPass: its `identificador`; Viafirma: `codRequest`).
   */
  getStatus(providerRequestId: string): Promise<CertificateProviderStatusResult>;

  /** Revokes the certificate. Each provider encapsulates its own mechanism — no shared revocation semantics are assumed beyond the result shape. */
  revoke(providerRequestId: string, reason?: string): Promise<CertificateProviderRevocationResult>;
}
