import { randomBytes } from "node:crypto";

import forge from "node-forge";

import type {
  CertificateProvider,
  CertificateProviderRevocationResult,
  CertificateProviderStatusResult,
  InternalCertificateStatus,
} from "./CertificateProvider.js";
import { ViafirmaApiClient } from "../viafirma/ViafirmaApiClient.js";

/**
 * ITCycle's integration with Viafirma Colombia's RA API for PKCS#10
 * profiles ("Uso del API para perfiles PKCS#10 v1.7", 25/08/2026 — RA
 * Viafirma Colombia; endpoints verified against the accompanying Postman
 * collection "RA Colombia - PKCS10 API.postman_collection v1.7").
 *
 * Every HTTP-backed method delegates to {@link ViafirmaApiClient}
 * (`../viafirma/ViafirmaApiClient.ts`, OAuth 1.0/HMAC-SHA1-signed, Fase 3).
 * The one deliberate exception is key/CSR generation
 * ({@link generateKeyPairAndCsr}) — still NOT implemented: per the product
 * brief's security requirement, the private key must never reach Viafirma
 * and must never leave ITCycle's own trust boundary, so that piece gets its
 * own dedicated pass (Fase 4) rather than being rushed in alongside the
 * HTTP client. It's kept as a static, standalone function (no I/O) so it
 * can be reviewed/tested in complete isolation from anything that talks to
 * Viafirma or FirmaPass.
 */
export class ViafirmaCertificateProvider implements CertificateProvider {
  readonly name = "viafirma";

  private readonly client: ViafirmaApiClient;

  constructor(private readonly config: ViafirmaProviderConfig) {
    this.client = new ViafirmaApiClient(config);
  }

  // ---------------------------------------------------------------------
  // CertificateProvider (shared, provider-agnostic surface)
  // ---------------------------------------------------------------------

  async getStatus(providerRequestId: string): Promise<CertificateProviderStatusResult> {
    const raw = await this.getRequestStatus(providerRequestId);
    return {
      internalStatus: mapViafirmaStatus(raw),
      providerStatus: raw,
      requiresUserAction: raw === "accreditation",
      requiresSupportIntervention: SUPPORT_REQUIRED_STATES.has(raw),
      failureReason: FAILURE_STATES.has(raw) ? raw : undefined,
    };
  }

  async revoke(providerRequestId: string, reason?: string): Promise<CertificateProviderRevocationResult> {
    const { revocationCode } = await this.getRevocationCode(providerRequestId);
    const { code } = await this.client.revokeByCode(revocationCode, reason ? 1 : 0);
    return { revoked: true, providerReference: code };
  }

  // ---------------------------------------------------------------------
  // Viafirma-specific issuance flow (§2.3 of the API doc) — NOT part of
  // CertificateProvider on purpose; see file-level doc on CertificateProvider.ts.
  // ---------------------------------------------------------------------

  /** GET /ra/available-profiles?codRa={ra} — §2.3.1. Profile codes differ between Sandbox and Production; MUST be re-fetched per environment, never hardcoded (doc's own warning). */
  async getAvailableProfiles(): Promise<ViafirmaAvailableProfile[]> {
    return this.client.getAvailableProfiles(this.config.ra);
  }

  /** GET /ra/profile/{codProfile}/form?required=true — §3.3. Field/validation-regex definitions Ohnix's own form should mirror without duplicating fields it already collects elsewhere. */
  async getProfileForm(codProfile: string): Promise<ViafirmaProfileFormField[]> {
    return this.client.getProfileForm(codProfile);
  }

  /** POST /request/fromCSR — §2.3.2. `csr` must already be base64-encoded PKCS#10 DER/PEM (see generateKeyPairAndCsr). */
  async createRequestFromCsr(params: ViafirmaCreateRequestParams): Promise<ViafirmaCreateRequestResult> {
    return this.client.createRequestFromCsr(params);
  }

  /** GET /request/{codRequest}/status — §2.3.4. Returns Viafirma's raw status code (see mapViafirmaStatus for the full table). */
  async getRequestStatus(codRequest: string): Promise<string> {
    return this.client.getRequestStatus(codRequest);
  }

  /** GET /services/accreditation/{codRequest} — §2.3.8. Only valid while status === "accreditation" (doc's own requisito); 400 `link_not_generated` otherwise. */
  async getKycLink(codRequest: string): Promise<string> {
    return this.client.getKycLink(codRequest);
  }

  /** POST /files/upload/ — §2.3.7. Used when status === "docRequired". */
  async uploadDocument(codRequest: string, file: ViafirmaFileUpload): Promise<ViafirmaUploadedFile[]> {
    return this.client.uploadFile(codRequest, file);
  }

  /** GET /files/list/{codRequest} — §2.3.7. */
  async listUploadedDocuments(codRequest: string): Promise<ViafirmaUploadedFile[]> {
    return this.client.listUploadedFiles(codRequest);
  }

  /**
   * GET {urlRADescarga}/downloadCertificateServlet?req={publicId} — §2.3.5.
   * Valid only for status Generated_Not_Downloaded / Generated_And_Downloaded / signedContract.
   * Returns the raw P7B bytes. Turning this into the PKCS12 ITCycle's
   * signing pipeline needs (see dianConfig.service.ts, which requires
   * `certificate: p12Buffer, certificatePassword`) is a SEPARATE step:
   * combine this P7B with the private key `generateKeyPairAndCsr` produced,
   * via `forge.pkcs12.toPkcs12Asn1` — same technique
   * `firmaPassIssuance.job.ts`'s `buildPkcs12` already uses for FirmaPass,
   * reusable here almost as-is. That combination step belongs in Fase 8
   * ("Implementar P7B + certificado final").
   */
  async downloadP7b(publicId: string): Promise<Buffer> {
    return this.client.downloadP7b(publicId);
  }

  /** GET /request/{codRequest}/revocationCode — §2.3.6. Valid for status inProcess and later. */
  async getRevocationCode(codRequest: string): Promise<ViafirmaRevocationCodeResult> {
    return this.client.getRevocationCode(codRequest);
  }

  /** POST /request/revoke/code/{revokingCode} — §2.3.6 (Postman collection; not spelled out in the PDF body). */
  async revokeByCode(revokingCode: string, reason?: string): Promise<CertificateProviderRevocationResult> {
    const { code } = await this.client.revokeByCode(revokingCode, reason ? 1 : 0);
    return { revoked: true, providerReference: code };
  }
}

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

export interface ViafirmaProviderConfig {
  /** https://sandbox.viafirma.com/ra/api/v2 or https://ecd.viafirma.com/ra/api/v2 — §2.1. */
  baseUrl: string;
  /** Separate download host used by §2.3.5 (`{{urlRADescarga}}`) — NOT the same as `baseUrl` per the doc's own placeholder naming; confirm the exact Sandbox/Production value in Fase 3 (REQUIERE_CONFIRMACION_VIAFIRMA: not spelled out anywhere in the PDF text itself, only implied by the Postman variable name). */
  downloadBaseUrl: string;
  /** OAuth 1.0 (HMAC-SHA1) credentials — §2.1. Backend-only; never sent to Frontend. */
  consumerKey: string;
  consumerSecret: string;
  /** RA code, e.g. "viafirmaco" — §2.3.1 `ra` param. */
  ra: string;
}

// ---------------------------------------------------------------------
// Types mirrored from the API doc / Postman collection
// ---------------------------------------------------------------------

export type ViafirmaProfileKind = "FE-PJ" | "FE-PN";

export interface ViafirmaAvailableProfile {
  /** Opaque, environment-specific — never hardcode across Sandbox/Production (doc's own warning, §2.3.1). */
  code: string;
  title: string;
  description: string;
  ra: string;
  type: "CORPORATIVO" | "INDIVIDUAL";
  dnPattern: string;
  altPattern: string;
  /** URL to the terms/conditions the subscriber must have accepted before this profile's request can be submitted — §3.4 (CEA-3.0-07 art. 10.11.1.e compliance requirement). Must be re-checked periodically, not cached indefinitely (doc's own warning). */
  terms: string;
  validity: number;
  token: "P7B";
}

export interface ViafirmaProfileFormField {
  label: string;
  name: string;
  defaultValue: string;
  profile: string;
  /** Regex string — empty when the field has no format constraint beyond required-ness. */
  validate: string;
  required: boolean;
  used: boolean;
  editable: boolean;
  type: "TEXT" | "EMAIL" | "SELECT" | "IDENTIFICATION";
  index: number;
}

interface ViafirmaCreateRequestParamsBase {
  /** "IDC" (cédula) | "PAS" (pasaporte) — §2.3.2.3. */
  identityType: "IDC" | "PAS";
  /** ISO 3166 alpha-2, e.g. "CO". */
  countryCode: string;
  identity: string;
  ra: string;
  codProfile: string;
  emailCertificate: string;
  /** Base64-encoded PKCS#10 — see generateKeyPairAndCsr. */
  csr: string;
}

export interface ViafirmaCreateRequestParamsPJ extends ViafirmaCreateRequestParamsBase {
  profileKind: "FE-PJ";
  /** "RM"|"PROP"|"RUNEOL"|"RNT"|"ESAL"|"ESOL"|"JUEGOS"|"EXTRANJERAS" — required for FE-PJ only. RM (Registro Mercantil) is the doc's own recommended default. */
  organizationType: "RM" | "PROP" | "RUNEOL" | "RNT" | "ESAL" | "ESOL" | "JUEGOS" | "EXTRANJERAS";
}

export interface ViafirmaCreateRequestParamsPN extends ViafirmaCreateRequestParamsBase {
  profileKind: "FE-PN";
}

export type ViafirmaCreateRequestParams = ViafirmaCreateRequestParamsPJ | ViafirmaCreateRequestParamsPN;

export interface ViafirmaCreateRequestResult {
  codRequest: string;
  publicId: string;
}

export interface ViafirmaFileUpload {
  /** Must include the extension, e.g. "escrituras.pdf" — §2.3.7 requisito. */
  name: string;
  base64: string;
}

export interface ViafirmaUploadedFile {
  id: string;
  name: string;
  uploadedByUser: boolean;
  size: number;
  dateAdded: number;
}

export interface ViafirmaRevocationCodeResult {
  typeCertificate: string;
  typeRequest: string;
  codRequest: string;
  status: string;
  revocationCode: string;
}

// ---------------------------------------------------------------------
// Status mapping (§2.3.4.1 happy path + §2.3.4.2 error states)
// ---------------------------------------------------------------------

const SUPPORT_REQUIRED_STATES = new Set([
  "rues_error",
  "accreditation_check", // only if it never clears — doc: "Si este estado no desaparece..."
  "collate_data",
  "accreditation_rejected",
  "checking",
  "docRequired",
  "docUploaded",
  "fail",
]);

const FAILURE_STATES = new Set(["rues_error", "accreditation_rejected", "fail"]);

/**
 * Maps every Viafirma workflow code documented in §2.3.4.1/§2.3.4.2 onto
 * {@link InternalCertificateStatus}. Kept as a pure function (no I/O) so it
 * can be unit-tested exhaustively against the doc's own state table without
 * any Sandbox credentials.
 */
export function mapViafirmaStatus(code: string): InternalCertificateStatus {
  switch (code) {
    case "rues_check":
    case "proposeFor":
    case "proposedToAcceptance":
    case "All_Ok":
    case "inProcess":
    case "checking":
    case "docUploaded":
    case "signedContract":
    case "Cite_To_Finish":
    case "processingContract":
      return "pending_provider_review";
    case "accreditation":
      return "awaiting_identity_verification";
    case "accreditation_check":
    case "accreditation_completed":
    case "accreditation_verified":
    case "collate_data":
      return "verifying_identity";
    case "accreditation_rejected":
      return "identity_rejected";
    case "docRequired":
      return "awaiting_documents";
    case "rues_error":
      // Split from "fail" - see InternalCertificateStatus's own doc comment.
      // The one failure state an applicant can usually fix themselves
      // (a wrong/malformed NIT) and retry, not a generic CA-side error.
      return "rues_verification_failed";
    case "fail":
      return "issuance_failed";
    case "Generated_Not_Downloaded":
      return "issued_ready_to_finalize";
    case "Generated_And_Downloaded":
      return "active";
    default:
      // Unknown/未documented code — treat conservatively as needing a human
      // rather than silently mapping to a "keep waiting" state.
      return "issuance_failed";
  }
}

// ---------------------------------------------------------------------
// Key/CSR generation — Fase 4. Declared here (not implemented) so the
// input shape is settled and the security-critical boundary is explicit:
// this function's output PRIVATE KEY must be handed directly to a
// CertificateSecretStore (../../shared/certificateStore.ts) and NEVER
// logged, returned over HTTP, or sent to Viafirma — only the CSR (public
// information) leaves this process via createRequestFromCsr.
// ---------------------------------------------------------------------

export interface ViafirmaCsrSubjectPJ {
  profileKind: "FE-PJ";
  /** C — ISO 3166 alpha-2, e.g. "CO". */
  country: string;
  /** ST — departamento. */
  state: string;
  /** L — ciudad. */
  locality: string;
  /** STREET. */
  address: string;
  /** O — organización. */
  organization: string;
  /** OU — unidad organizativa. */
  organizationalUnit: string;
  /** SERIALNUMBER — NIT. */
  nit: string;
  /** E. */
  email: string;
  /** GN — nombre del representante legal. */
  givenName: string;
  /** SN — apellidos del representante legal. */
  surname: string;
}

export interface ViafirmaCsrSubjectPN {
  profileKind: "FE-PN";
  country: string;
  state: string;
  locality: string;
  address: string;
  /** SERIALNUMBER — cédula. */
  identity: string;
  email: string;
  givenName: string;
  surname: string;
}

export type ViafirmaCsrSubject = ViafirmaCsrSubjectPJ | ViafirmaCsrSubjectPN;

export interface GeneratedKeyPairAndCsr {
  /** PEM-encoded PKCS#10, ready for base64 encoding into ViafirmaCreateRequestParams.csr. */
  csrPem: string;
  /** PEM-encoded RSA private key. Caller MUST move this into a CertificateSecretStore immediately and MUST NOT log it — same discipline `firmaPassIssuance.service.ts`'s `confirmValidation` already follows for FirmaPass's `private_key_pem`. */
  privateKeyPem: string;
}

/**
 * A CSR subject RDN as node-forge's `setSubject` expects it. Deliberately
 * keyed by `name` (the long-form OID name from `forge.pki.oids`, e.g.
 * "streetAddress") rather than `shortName` — forge only pre-registers
 * shortName aliases for CN/C/L/ST/O/OU/E (see its internal `_shortNames`
 * table in x509.js); asking it to resolve "STREET", "GN", "SN", or
 * "SERIALNUMBER" as shortNames throws "Attribute type not specified."
 * `name` resolves correctly for all ten attributes this profile needs.
 */
type SubjectAttr = { name: string; value: string };

function requireNonEmpty(fields: Record<string, string>): void {
  const empty = Object.entries(fields)
    .filter(([, value]) => !value || !value.trim())
    .map(([key]) => key);
  if (empty.length > 0) {
    throw new Error(`generateKeyPairAndCsr: missing required subject field(s): ${empty.join(", ")}`);
  }
}

/**
 * Builds the CSR subject exactly as documented in §3.1 (FE-PJ, 10
 * attributes) / §3.2 (FE-PN, 9 attributes) — no CN, no extra attributes.
 * Viafirma synthesizes the certificate's own CN server-side from these
 * fields per each profile's `dnPattern` (see §2.3.1 example responses); we
 * do not construct or guess it ourselves.
 */
function buildSubjectAttrs(subject: ViafirmaCsrSubject): SubjectAttr[] {
  if (subject.profileKind === "FE-PJ") {
    requireNonEmpty({
      country: subject.country,
      state: subject.state,
      locality: subject.locality,
      address: subject.address,
      organization: subject.organization,
      organizationalUnit: subject.organizationalUnit,
      nit: subject.nit,
      email: subject.email,
      givenName: subject.givenName,
      surname: subject.surname,
    });
    return [
      { name: "countryName", value: subject.country },
      { name: "stateOrProvinceName", value: subject.state },
      { name: "localityName", value: subject.locality },
      { name: "streetAddress", value: subject.address },
      { name: "organizationName", value: subject.organization },
      { name: "organizationalUnitName", value: subject.organizationalUnit },
      { name: "serialNumber", value: subject.nit },
      { name: "emailAddress", value: subject.email },
      { name: "givenName", value: subject.givenName },
      { name: "surname", value: subject.surname },
    ];
  }

  requireNonEmpty({
    country: subject.country,
    state: subject.state,
    locality: subject.locality,
    address: subject.address,
    identity: subject.identity,
    email: subject.email,
    givenName: subject.givenName,
    surname: subject.surname,
  });
  return [
    { name: "countryName", value: subject.country },
    { name: "stateOrProvinceName", value: subject.state },
    { name: "localityName", value: subject.locality },
    { name: "streetAddress", value: subject.address },
    { name: "serialNumber", value: subject.identity },
    { name: "emailAddress", value: subject.email },
    { name: "givenName", value: subject.givenName },
    { name: "surname", value: subject.surname },
  ];
}

/**
 * Generates a fresh RSA-2048 keypair and a PKCS#10 CSR from it (SHA-256
 * signature) — entirely local, no network, no Viafirma or FirmaPass
 * involvement. RSA-2048 is not specified by the API doc; it's the
 * conservative modern default node-forge itself recommends and matches the
 * key size implied by the PKCS12s FirmaPass already issues through this
 * codebase.
 *
 * The returned `privateKeyPem` is the one piece of this whole integration
 * that must NEVER reach Viafirma, never be logged, and never be returned
 * over an HTTP response — the caller's ONLY next step for it should be
 * `CertificateSecretStore.save` (see `../../shared/certificateStore.ts`),
 * exactly like `firmaPassIssuance.service.ts`'s `confirmValidation` already
 * does for FirmaPass's `private_key_pem`. `csrPem` (public information) is
 * the only thing that goes on to `ViafirmaCertificateProvider.createRequestFromCsr`.
 */
export function generateKeyPairAndCsr(subject: ViafirmaCsrSubject): GeneratedKeyPairAndCsr {
  const attrs = buildSubjectAttrs(subject);

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject(attrs);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  const verified = csr.verify();
  if (!verified) {
    // Should be unreachable (we just signed it ourselves) — a paranoia
    // check against a subtly broken forge build silently producing an
    // invalid CSR that would only surface as a confusing Viafirma rejection.
    throw new Error("generateKeyPairAndCsr: freshly generated CSR failed self-verification");
  }

  return {
    csrPem: forge.pki.certificationRequestToPem(csr),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// ---------------------------------------------------------------------
// P7B + private key -> PKCS12 (Fase 8's pure/local piece — no network).
// ---------------------------------------------------------------------

export interface FinalizedCertificate {
  /** DER-encoded PKCS#12 bytes — hand this + `password` straight to a CertificateSecretStore.save({p12, password}). */
  p12: Buffer;
  password: string;
  /** The leaf certificate's own `notAfter` — real expiry, not a guess from the profile's `validity` (days). */
  expiresAt: Date;
}

/**
 * Combines a P7B downloaded from Viafirma (§2.3.5 — `ViafirmaCertificateProvider.downloadP7b`)
 * with the private key `generateKeyPairAndCsr` produced for that SAME
 * request, into a PKCS12 that ITCycle's DIAN-signing pipeline can consume
 * directly (`dianConfig.service.ts` expects `{certificate: p12Buffer,
 * certificatePassword}`, same shape `firmaPassIssuance.job.ts`'s
 * `buildPkcs12` already produces for FirmaPass certificates).
 *
 * Unlike FirmaPass (which hands back one bare certificate PEM),
 * Viafirma's P7B is a PKCS#7 "certs-only" bundle that may contain the leaf
 * certificate AND the issuing CA certificate(s). This function:
 *   1. parses the P7B (raw DER bytes — despite §2.3.5's text saying
 *      "devuelve el base64 del P7B", the Postman collection's own example
 *      response is raw binary with Content-Type: application/x-pkcs7-certificates,
 *      which is what `ViafirmaApiClient.downloadP7b` already returns);
 *   2. identifies the LEAF certificate as the one whose RSA public key
 *      matches the private key we generated (never assumes an order/count);
 *   3. builds the PKCS12 with the leaf first, followed by any other
 *      certificates from the P7B (the issuing CA chain), so downstream
 *      validation has the full chain available, not just the leaf.
 *
 * Throws if the P7B contains no certificate matching our private key —
 * that would mean either the wrong P7B/key pair was paired up, or Viafirma
 * issued against a different CSR than the one this process submitted;
 * silently picking an arbitrary certificate in that case would produce a
 * PKCS12 that LOOKS valid but can never actually sign anything.
 */
export function assemblePkcs12FromP7b(p7bBytes: Buffer, privateKeyPem: string): FinalizedCertificate {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p7bBytes.toString("binary")));
  const message = forge.pkcs7.messageFromAsn1(asn1) as unknown as forge.pkcs7.PkcsSignedData;
  const certificates = message.certificates;
  if (!certificates || certificates.length === 0) {
    throw new Error("assemblePkcs12FromP7b: P7B contains no certificates");
  }

  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem) as forge.pki.rsa.PrivateKey;
  const leafIndex = certificates.findIndex((cert) => certificateMatchesPrivateKey(cert, privateKey));
  if (leafIndex === -1) {
    throw new Error(
      "assemblePkcs12FromP7b: none of the certificates in the P7B match the private key generated for this " +
        "request — wrong P7B/key pair, or Viafirma issued against a different CSR than the one submitted.",
    );
  }
  const chain = [certificates[leafIndex], ...certificates.filter((_, index) => index !== leafIndex)];

  const password = randomBytes(24).toString("base64url");
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, chain, password, { algorithm: "3des" });
  return {
    p12: Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary"),
    password,
    expiresAt: certificates[leafIndex].validity.notAfter,
  };
}

function certificateMatchesPrivateKey(cert: forge.pki.Certificate, privateKey: forge.pki.rsa.PrivateKey): boolean {
  const publicKey = cert.publicKey as Partial<forge.pki.rsa.PublicKey>;
  return Boolean(publicKey?.n?.equals(privateKey.n) && publicKey?.e?.equals(privateKey.e));
}
