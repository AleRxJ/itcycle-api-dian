import { randomUUID } from "node:crypto";

import { prisma } from "../../infrastructure/prisma.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { generateApiKey } from "../../shared/apiKeyAuth.js";
import { env } from "../../shared/env.js";
import type { DianKitConfig } from "@dian-kit/sdk-node";
import { DianTransportError } from "@dian-kit/sdk-node";

import { findSigningCertificate, loadDianConfig, type NumberedDocumentType } from "../documents/dianConfig.service.js";
import { isStillValidatingMessage, isTestSetAlreadyAcceptedMessage } from "../documents/documentSend.service.js";
import { createDefaultRawResponseStore } from "../../shared/rawResponseStore.js";
import { DianKitProvider } from "../../providers/dian/DianKitProvider.js";
import { SimulatedDianProvider } from "../../providers/dian/SimulatedDianProvider.js";

export interface CreateCompanyParams {
  name: string;
  nit: string;
  dv: string;
  personType: string;
}

/** Idempotent by (nit, dv) — re-provisioning the same tax id returns the existing Company instead of failing. */
export async function createCompany(params: CreateCompanyParams) {
  const existing = await prisma.company.findUnique({ where: { nit_dv: { nit: params.nit, dv: params.dv } } });
  if (existing) return existing;
  return prisma.company.create({ data: params });
}

/**
 * Every company this instance has ever provisioned - there was no way to
 * enumerate this before (createCompany is the only write, and it's
 * idempotent-by-lookup rather than list-backed), which left a caller like
 * Ohnix's own admin UI with nothing to cross-check its own bookkeeping
 * against. Includes an apiKeys count so a caller can tell "provisioned, no
 * key issued yet" apart from "has at least one key" without a second call
 * per row.
 */
export async function listCompanies() {
  return prisma.company.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { apiKeys: true } } },
  });
}

export interface SetDianConfigurationParams {
  companyId: string;
  environment: "PRODUCTION" | "SANDBOX";
  softwareId: string;
  softwarePin: string;
  technicalKey?: string;
  supplierProfile: Record<string, unknown>;
}

export async function setDianConfiguration(params: SetDianConfigurationParams) {
  const { companyId, supplierProfile, ...rest } = params;
  const data = { ...rest, supplierProfile: supplierProfile as object };
  return prisma.dianConfiguration.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
}

/**
 * Flips ONLY the environment of an existing DianConfiguration (the
 * SANDBOX -> PRODUCTION step once DIAN approves a company's habilitación).
 * The full PUT above needs softwarePin/technicalKey, which the caller (Ohnix)
 * deliberately never keeps a copy of - so without this, going live meant
 * re-typing the PIN by hand. Throws if there's no configuration yet: there
 * is nothing to promote. Returns only non-secret fields.
 */
export async function setDianEnvironment(companyId: string, environment: "PRODUCTION" | "SANDBOX") {
  const config = await prisma.dianConfiguration.update({
    where: { companyId },
    data: { environment },
  });
  return { companyId: config.companyId, environment: config.environment, softwareId: config.softwareId };
}

export interface CreateNumberingResolutionParams {
  companyId: string;
  documentType: "01" | "91" | "92" | "05";
  prefix: string;
  resolutionNumber: string;
  startNumber: number;
  endNumber: number;
  startDate: string;
  endDate: string;
}

export async function createNumberingResolution(params: CreateNumberingResolutionParams) {
  return prisma.numberingResolution.create({
    data: {
      companyId: params.companyId,
      documentType: params.documentType,
      prefix: params.prefix,
      resolutionNumber: params.resolutionNumber,
      startNumber: params.startNumber,
      endNumber: params.endNumber,
      currentNumber: params.startNumber,
      startDate: new Date(params.startDate),
      endDate: new Date(params.endDate),
    },
  });
}

export interface UpdateNumberingResolutionParams {
  companyId: string;
  resolutionId: string;
  prefix?: string;
  resolutionNumber?: string;
  startNumber?: number;
  endNumber?: number;
  startDate?: string;
  endDate?: string;
}

/**
 * Statuses whose document never became (and never will become) a valid
 * document on DIAN's side - DIAN rejected it, or it failed before DIAN ever
 * accepted it. Everything else (ACCEPTED, but also PENDING/PROCESSING/SENT,
 * whose outcome isn't known yet, and CONTINGENCY, which is legally issued
 * and only waiting to be transmitted) counts as a live document.
 */
const DEAD_DOCUMENT_STATUSES = ["REJECTED", "ERROR"] as const;

/**
 * How many live documents (see DEAD_DOCUMENT_STATUSES) each of the given
 * resolutions has issued against it, across every document table that
 * claims numbers from a NumberingResolution. Ids with none are absent from
 * the map. Shared by updateNumberingResolution (the lock itself) and
 * getDianReadiness (its `editable` flag) so the two can never disagree.
 */
async function countLiveDocumentsByResolution(numberingIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (numberingIds.length === 0) return counts;
  const where = { numberingId: { in: numberingIds }, status: { notIn: [...DEAD_DOCUMENT_STATUSES] } };
  const groups = await Promise.all([
    prisma.invoice.groupBy({ by: ["numberingId"], where, _count: { _all: true } }),
    prisma.creditNote.groupBy({ by: ["numberingId"], where, _count: { _all: true } }),
    prisma.debitNote.groupBy({ by: ["numberingId"], where, _count: { _all: true } }),
    prisma.supportDocument.groupBy({ by: ["numberingId"], where, _count: { _all: true } }),
    prisma.payrollDocument.groupBy({ by: ["numberingId"], where, _count: { _all: true } }),
    prisma.payrollAdjustment.groupBy({ by: ["numberingId"], where, _count: { _all: true } }),
  ]);
  for (const group of groups.flat()) {
    if (!group.numberingId) continue;
    counts.set(group.numberingId, (counts.get(group.numberingId) ?? 0) + group._count._all);
  }
  return counts;
}

/**
 * Corrects a resolution's own fields (prefix/resolutionNumber/range/dates) -
 * never documentType, which is the row's identity. Only refused once a LIVE
 * document (see DEAD_DOCUMENT_STATUSES) was issued against it: its
 * range/prefix are then part of that document's permanent record on DIAN's
 * side, and editing them out from under it would desync what was actually
 * issued from what the resolution now says - that case needs a NEW
 * resolution (superseding it), not an edit of this one. Documents DIAN
 * rejected left nothing on record, so they don't lock it: a resolution typed
 * in wrong (e.g. FAB05b on a habilitación test set) must stay fixable.
 *
 * currentNumber is only reset when startNumber actually changes - otherwise
 * the numbers already burned by rejected documents stay skipped (DIAN allows
 * gaps).
 */
export async function updateNumberingResolution(params: UpdateNumberingResolutionParams) {
  const existing = await prisma.numberingResolution.findUnique({ where: { id: params.resolutionId } });
  if (!existing || existing.companyId !== params.companyId) {
    throw new Error(`Numbering resolution ${params.resolutionId} not found for company ${params.companyId}`);
  }

  const liveDocuments = (await countLiveDocumentsByResolution([existing.id])).get(existing.id) ?? 0;
  if (liveDocuments > 0) {
    throw new Error(
      `Numbering resolution ${params.resolutionId} already has ${liveDocuments} document(s) issued against it that DIAN accepted or may still accept - it can no longer be edited, only superseded by a new one.`,
    );
  }

  const startNumberChanged = params.startNumber !== undefined && params.startNumber !== existing.startNumber;

  return prisma.numberingResolution.update({
    where: { id: params.resolutionId },
    data: {
      ...(params.prefix !== undefined ? { prefix: params.prefix } : {}),
      ...(params.resolutionNumber !== undefined ? { resolutionNumber: params.resolutionNumber } : {}),
      ...(startNumberChanged ? { startNumber: params.startNumber, currentNumber: params.startNumber } : {}),
      ...(params.endNumber !== undefined ? { endNumber: params.endNumber } : {}),
      ...(params.startDate !== undefined ? { startDate: new Date(params.startDate) } : {}),
      ...(params.endDate !== undefined ? { endDate: new Date(params.endDate) } : {}),
    },
  });
}

export interface UploadCertificateParams {
  companyId: string;
  provider: string;
  certificateIdentifier: string;
  p12Base64: string;
  password: string;
  expiresAt: string;
}

/**
 * Stores the .p12 via the same encrypted-by-default store the document
 * services use (createDefaultCertificateSecretStore) and persists only the
 * metadata row — the .p12 bytes and password are never returned in the
 * response, and never touch a database column.
 */
export async function uploadCertificate(params: UploadCertificateParams) {
  const secretStore = createDefaultCertificateSecretStore();
  const secretReference = randomUUID();

  await secretStore.save(secretReference, {
    p12: Buffer.from(params.p12Base64, "base64"),
    password: params.password,
  });

  const certificate = await prisma.certificate.create({
    data: {
      companyId: params.companyId,
      provider: params.provider,
      certificateIdentifier: params.certificateIdentifier,
      secretReference,
      expiresAt: new Date(params.expiresAt),
    },
  });

  return { id: certificate.id, certificateIdentifier: certificate.certificateIdentifier, expiresAt: certificate.expiresAt };
}

export interface FirmaPassStatusCertificate {
  id: string;
  certificateIdentifier: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  /** Only populated by getDianReadiness (every provider); getFirmaPassStatus's own list is already firmapass-only, so it's redundant there. */
  provider?: string;
}

export interface FirmaPassStatus {
  loginKeySet: boolean;
  certificates: FirmaPassStatusCertificate[];
}

export interface DianReadiness {
  canIssueInvoices: boolean;
  environment: "SANDBOX" | "PRODUCTION" | null;
  // Not a secret (unlike softwarePin/technicalKey, which never leave this
  // service) - Ohnix's settings UI shows it back to the company so they can
  // see what got registered under their own DIAN habilitación.
  softwareId: string | null;
  configurationReady: boolean;
  invoiceResolutionReady: boolean;
  certificateReady: boolean;
  activeCertificateCount: number;
  missing: string[];
  resolutions: Array<{
    id: string;
    documentType: string;
    prefix: string;
    resolutionNumber: string;
    // Not secret, and needed for Ohnix's self-service edit form (see
    // updateNumberingResolution) to pre-fill the current range instead of
    // asking the owner to re-type numbers they can't otherwise see here.
    startNumber: number;
    endNumber: number;
    currentNumber: number;
    startDate: Date;
    endDate: Date;
    status: string;
    isCurrent: boolean;
    /** False once a live document was issued against it - updateNumberingResolution would refuse the edit. */
    editable: boolean;
  }>;
  certificates: FirmaPassStatusCertificate[];
  /**
   * The non-secret part of DianConfiguration.supplierProfile (who the
   * issuer is and where) - Ohnix prints it on the invoice's representación
   * gráfica, and this service is the only place it is stored. Null until a
   * DianConfiguration exists.
   */
  supplier: {
    name: string | null;
    identification: unknown;
    fiscalResponsibilities: unknown;
    address: unknown;
    email: string | null;
  } | null;
}

/**
 * Authoritative readiness projection consumed by Ohnix. It intentionally
 * evaluates the same prerequisites the document services need at runtime,
 * but does so before a user clicks "emit". This makes onboarding truthful:
 * provisioning alone never means a business can already invoice.
 */
export async function getDianReadiness(companyId: string): Promise<DianReadiness> {
  const now = new Date();
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: {
      dianConfiguration: true,
      numberingResolutions: { orderBy: { createdAt: "desc" } },
      certificates: { orderBy: { createdAt: "desc" } },
    },
  });

  const configurationReady = Boolean(
    company.dianConfiguration?.supplierProfile
      && company.dianConfiguration.softwareId
      && company.dianConfiguration.softwarePin,
  );
  const activeInvoiceResolution = company.numberingResolutions.find((resolution) =>
    resolution.documentType === "01"
      && resolution.status === "ACTIVE"
      && resolution.startDate <= now
      && resolution.endDate >= now
      && resolution.currentNumber <= resolution.endNumber,
  );
  // Mirrors dianConfig.service.ts's loadDianConfig exactly (including the
  // certificateProviderOverride filter) - otherwise this could report
  // "ready" off some other provider's active certificate while the real
  // signing call throws because the company's chosen override doesn't match it.
  const activeCertificates = company.certificates.filter((certificate) =>
    certificate.status === "ACTIVE"
      && (!certificate.expiresAt || certificate.expiresAt >= now)
      && (!company.certificateProviderOverride || certificate.provider === company.certificateProviderOverride),
  );
  const liveDocumentsByResolution = await countLiveDocumentsByResolution(company.numberingResolutions.map((resolution) => resolution.id));
  const missing: string[] = [];
  if (!configurationReady) missing.push("dian_configuration");
  if (!activeInvoiceResolution) missing.push("invoice_resolution_01");
  if (activeCertificates.length === 0) missing.push("active_certificate");

  return {
    canIssueInvoices: missing.length === 0,
    environment: company.dianConfiguration?.environment ?? null,
    softwareId: company.dianConfiguration?.softwareId ?? null,
    configurationReady,
    invoiceResolutionReady: Boolean(activeInvoiceResolution),
    certificateReady: activeCertificates.length > 0,
    activeCertificateCount: activeCertificates.length,
    missing,
    resolutions: company.numberingResolutions.map((resolution) => ({
      id: resolution.id,
      documentType: resolution.documentType,
      prefix: resolution.prefix,
      resolutionNumber: resolution.resolutionNumber,
      startNumber: resolution.startNumber,
      endNumber: resolution.endNumber,
      currentNumber: resolution.currentNumber,
      startDate: resolution.startDate,
      endDate: resolution.endDate,
      status: resolution.status,
      isCurrent: resolution.status === "ACTIVE" && resolution.startDate <= now && resolution.endDate >= now && resolution.currentNumber <= resolution.endNumber,
      editable: !liveDocumentsByResolution.has(resolution.id),
    })),
    certificates: company.certificates.map((certificate) => ({
      id: certificate.id,
      certificateIdentifier: certificate.certificateIdentifier,
      provider: certificate.provider,
      status: certificate.status,
      expiresAt: certificate.expiresAt,
      createdAt: certificate.createdAt,
    })),
    supplier: supplierSummary(company.dianConfiguration?.supplierProfile),
  };
}

function supplierSummary(profile: unknown): DianReadiness["supplier"] {
  if (!profile || typeof profile !== "object") return null;
  const p = profile as Record<string, unknown>;
  return {
    name: typeof p.name === "string" ? p.name : null,
    identification: p.identification ?? null,
    fiscalResponsibilities: p.fiscalResponsibilities ?? null,
    address: p.address ?? null,
    email: typeof p.email === "string" ? p.email : null,
  };
}

export interface CertificateProviderStatus {
  /** Providers this company currently has an ACTIVE, non-expired Certificate for - the set a UI could actually choose between. */
  activeProviders: string[];
  /** Null for every company by default - see Company.certificateProviderOverride and loadDianConfig. */
  override: string | null;
}

/**
 * Read-only projection for the "which provider signs my documents" UI - a
 * selector only makes sense to show when `activeProviders.length > 1`
 * (more than one provider has a currently-usable certificate at once).
 */
export async function getCertificateProviderStatus(companyId: string): Promise<CertificateProviderStatus> {
  const now = new Date();
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { certificates: true },
  });
  const activeProviders = [
    ...new Set(
      company.certificates
        .filter((c) => c.status === "ACTIVE" && (!c.expiresAt || c.expiresAt >= now))
        .map((c) => c.provider),
    ),
  ];
  return { activeProviders, override: company.certificateProviderOverride };
}

/**
 * Sets (or clears, with `provider: null`) which certificate provider signs
 * this company's real documents - see Company.certificateProviderOverride
 * and loadDianConfig. Refuses a provider the company has no ACTIVE
 * certificate for, since that would just make loadDianConfig throw on the
 * next real document instead of failing clearly right here.
 */
export async function setCertificateProviderOverride(companyId: string, provider: string | null): Promise<CertificateProviderStatus> {
  if (provider !== null) {
    const status = await getCertificateProviderStatus(companyId);
    if (!status.activeProviders.includes(provider)) {
      throw new Error(`Company ${companyId} has no ACTIVE certificate from provider "${provider}" - cannot set it as the certificateProviderOverride.`);
    }
  }
  await prisma.company.update({ where: { id: companyId }, data: { certificateProviderOverride: provider } });
  return getCertificateProviderStatus(companyId);
}

/** Read-only snapshot for Ohnix's admin UI — no schema change, just a projection of existing columns. */
export async function getFirmaPassStatus(companyId: string): Promise<FirmaPassStatus> {
  const certificates = await prisma.certificate.findMany({
    where: { companyId, provider: "firmapass" },
    orderBy: { createdAt: "desc" },
  });

  // loginKeySet now reflects iTCycle's shared FirmaPass "alianza" account
  // (env.firmaPassAllianceLoginKey), not a per-company credential — see
  // modules/firmapass/firmaPassIssuance.service.ts. Same value for every
  // company; kept in the per-company response shape so Ohnix's existing UI
  // doesn't need a separate call to learn it.
  return {
    loginKeySet: Boolean(env.firmaPassAllianceLoginKey),
    certificates: certificates.map((c) => ({
      id: c.id,
      certificateIdentifier: c.certificateIdentifier,
      status: c.status,
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
    })),
  };
}

export interface CreateApiKeyParams {
  companyId: string;
  label: string;
}

/** Same generation logic as scripts/create-api-key.ts, as an HTTP endpoint for Ohnix's provisioning flow. */
export async function createApiKeyForCompany(params: CreateApiKeyParams) {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  await prisma.apiKey.create({
    data: { companyId: params.companyId, keyHash, keyPrefix, label: params.label },
  });
  // The only place the raw key is ever returned — callers must persist it immediately (see docs/dian/sandbox-tests.md).
  return { rawKey };
}

/**
 * Every key ever issued for a company - metadata only (keyPrefix/label/
 * status/lastUsedAt), never keyHash. The hash isn't the usable secret (the
 * raw key is gone forever once createApiKeyForCompany returns it), but
 * there's no reason for a list view to carry it either.
 */
export async function listApiKeysForCompany(companyId: string) {
  return prisma.apiKey.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      keyPrefix: true,
      label: true,
      status: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export interface CompanyDocumentUsage {
  year: number;
  month: number;
  invoices: number;
  creditNotes: number;
  debitNotes: number;
  supportDocuments: number;
  total: number;
}

/**
 * Read-only billable-usage count for a given calendar month (defaults to the
 * current one) — the number of documents that actually reached DIAN
 * acceptance (`status: "ACCEPTED"`), not merely attempted. This is what
 * Ohnix's admin panel shows to manually invoice an external API client
 * against its published per-document pricing; a document only counts once
 * DIAN itself has accepted it.
 */
export async function getCompanyDocumentUsage(
  companyId: string,
  params?: { year?: number; month?: number },
): Promise<CompanyDocumentUsage> {
  const now = new Date();
  const year = params?.year ?? now.getFullYear();
  const month = params?.month ?? now.getMonth() + 1; // 1-12, matching the API's own convention

  const startOfMonth = new Date(year, month - 1, 1);
  const startOfNextMonth = new Date(year, month, 1);

  const [invoices, creditNotes, debitNotes, supportDocuments] = await Promise.all([
    prisma.invoice.count({ where: { companyId, status: "ACCEPTED", createdAt: { gte: startOfMonth, lt: startOfNextMonth } } }),
    prisma.creditNote.count({ where: { companyId, status: "ACCEPTED", createdAt: { gte: startOfMonth, lt: startOfNextMonth } } }),
    prisma.debitNote.count({ where: { companyId, status: "ACCEPTED", createdAt: { gte: startOfMonth, lt: startOfNextMonth } } }),
    prisma.supportDocument.count({ where: { companyId, status: "ACCEPTED", createdAt: { gte: startOfMonth, lt: startOfNextMonth } } }),
  ]);

  return {
    year,
    month,
    invoices,
    creditNotes,
    debitNotes,
    supportDocuments,
    total: invoices + creditNotes + debitNotes + supportDocuments,
  };
}

// "NE" (payroll) added alongside "01"/"91"/"92" - nómina reuses the same
// SendBillSync/SendBillAsync/SendTestSetAsync transport as invoicing (see
// constants/dian-endpoints.ts), so it can land in the same async "SENT"
// intermediate status this function resolves. "05" (support document) stays
// excluded - it never takes the async path (see contingencyRetry.job.ts).
// "NE_ADJUSTMENT" is NOT a NumberedDocumentType (adjustments share "NE"'s own
// numbering pool, they don't have a separate one) - it exists purely as a
// second discriminator so this same refresh mechanism can target the
// PayrollAdjustment table instead of PayrollDocument, confirmed necessary by
// scripts/smoke-test-payroll.ts: an adjustment can land in "SENT" exactly
// like its parent document.
export type RefreshableDocumentType = Extract<NumberedDocumentType, "01" | "91" | "92" | "NE"> | "NE_ADJUSTMENT";

export interface RefreshDocumentStatusParams {
  companyId: string;
  documentType: RefreshableDocumentType;
  id: string;
}

/**
 * Resolves the REAL final DIAN verdict for a document left in the "SENT"
 * intermediate status by an async send (SendBillAsync/SendTestSetAsync) —
 * see documentSend.service.ts's computeSentStatusFields for why that status
 * exists instead of an immediate ACCEPTED/REJECTED guess.
 *
 * Purely additive and safe to call repeatedly: a document not in "SENT" is
 * already terminal (ACCEPTED/REJECTED/CONTINGENCY/ERROR) and is returned
 * unchanged without any DIAN call, so polling this endpoint on a loop from
 * Ohnix never risks re-querying DIAN for documents that don't need it.
 */
/** DIAN's answer to a status query made with an identifier it can't read - says nothing about the document. */
const isBadTrackIdAnswer = (text: string | null | undefined) => /trackid inv[aá]lido/i.test(text ?? "");
/** GetStatusZip only takes an async send's ZipKey (a UUID). */
const isZipKey = (value: string | null | undefined) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "");

export async function refreshDocumentStatus(params: RefreshDocumentStatusParams) {
  const record = await findDocumentRecord(params.documentType, params.companyId, params.id);
  if (!record) {
    throw new Error(`Document ${params.id} (type ${params.documentType}) not found for company ${params.companyId}`);
  }
  const cufe = (record as { cufe?: string | null }).cufe ?? null;
  // A REJECTED whose only "reason" is DIAN not understanding our own status
  // query was never a DIAN verdict - re-ask (by CUFE) instead of keeping it.
  const simulatedDocument = Boolean((record as { simulated?: boolean }).simulated);
  const misrecorded = Boolean(cufe) && !simulatedDocument && (
    (record.status === "REJECTED" && (isBadTrackIdAnswer(record.statusDescription) || isBadTrackIdAnswer(record.errorMessage)))
    // A REAL document "accepted" by the simulator (a local instance with
    // DIAN_SIMULATION_MODE on, pointed at production data) - never DIAN's word.
    || (record.status === "ACCEPTED" && /^\[SIMULADO\]/.test(record.statusDescription ?? ""))
  );
  if (record.status !== "SENT" && !misrecorded) {
    // Already terminal (or never sent) - nothing to refresh.
    return record;
  }
  if (!record.trackId && !misrecorded) {
    // Legitimately possible now, not just a caller mistake: DIAN accepted the
    // batch for async validation but issued no ZipKey (see
    // documentSend.service.ts's isStillValidatingMessage) - there is nothing
    // to poll GetStatusZip with. Only a resend can move this forward (see
    // retryXxxSend + contingencyRetry.job.ts, which sweeps this case), so
    // this just returns the record unchanged instead of throwing - safe to
    // call repeatedly, exactly like every other branch here.
    return record;
  }

  // "NE_ADJUSTMENT" is this function's own discriminator (see
  // RefreshableDocumentType) - adjustments don't have a separate numbering
  // resolution, they draw from "NE"'s, so that's what loadDianConfig needs.
  const numberingDocumentType = params.documentType === "NE_ADJUSTMENT" ? "NE" : params.documentType;
  const secretStore = createDefaultCertificateSecretStore();
  const { config } = await loadDianConfig({ companyId: params.companyId, documentType: numberingDocumentType }, secretStore);
  // The simulator only answers for documents it produced; a real document is
  // always asked to the real DIAN (read-only), whatever this instance's mode.
  const provider = simulatedDocument ? new SimulatedDianProvider(config) : new DianKitProvider(config);

  // A real async ZipKey -> GetStatusZip; anything else (a sync send's file
  // name stored as trackId by an older engine, or a misrecorded REJECTED) ->
  // GetStatus by CUFE, which answers for any document DIAN received.
  const status = isZipKey(record.trackId) || !cufe
    ? await provider.getStatusZip(record.trackId as string)
    : await provider.getStatus(cufe);

  if (isBadTrackIdAnswer(status.statusDescription) || isBadTrackIdAnswer(status.errors?.map((e) => e.description).join("; "))) {
    // Our query was malformed - NOT a verdict on the document. Keep it as is
    // (and never overwrite the stored DIAN answer with this one).
    return record;
  }

  // Re-asking a misrecorded document (always a sync send - DIAN validated it
  // on the spot): "not found" (66/90) can't mean "still processing" here. It
  // means DIAN never accepted it, so record that - the sale can then be
  // issued again instead of staying stuck on a verdict DIAN never gave.
  if (misrecorded && !status.isValid && (status.statusCode === "66" || status.statusCode === "90")) {
    return updateDocumentRecord(params.documentType, record.id, {
      status: "REJECTED",
      statusDescription: status.statusDescription || "La DIAN no tiene registrado este documento",
      acceptedAt: null,
      rejectedAt: new Date(),
      errorMessage: `La DIAN no tiene registrado este documento (${status.statusCode}${status.statusDescription ? `: ${status.statusDescription}` : ""}). Vuelve a emitirlo.`,
    });
  }

  if (status.statusCode === "66" || (!status.isValid && isStillValidatingMessage(status.statusDescription))) {
    // Still processing on DIAN's side - not terminal yet (either DIAN's own
    // "still processing" code, or the "en proceso de validación" phrasing -
    // see documentSend.service.ts's isStillValidatingMessage, which this
    // mirrors so a poll can't terminalize what computeSentStatusFields's own
    // initial-send check would have treated as non-terminal). Just refresh
    // the description; a later poll (or contingencyRetry.job.ts's sweep)
    // tries again.
    return updateDocumentRecord(params.documentType, record.id, { statusDescription: status.statusDescription });
  }

  if (record.xmlReference) {
    await createDefaultRawResponseStore().save(record.xmlReference, status.rawResponse);
  }

  const now = new Date();
  const accepted = status.isValid || isTestSetAlreadyAcceptedMessage(status.statusDescription);
  return updateDocumentRecord(params.documentType, record.id, {
    status: accepted ? "ACCEPTED" : "REJECTED",
    statusDescription: status.statusDescription,
    dianResponseReference: record.xmlReference,
    acceptedAt: accepted ? now : null,
    rejectedAt: accepted ? null : now,
    errorMessage: status.errors?.map((e) => e.description).join("; ") || null,
  });
}

function findDocumentRecord(documentType: RefreshableDocumentType, companyId: string, id: string) {
  switch (documentType) {
    case "01":
      return prisma.invoice.findFirst({ where: { id, companyId } });
    case "91":
      return prisma.creditNote.findFirst({ where: { id, companyId } });
    case "92":
      return prisma.debitNote.findFirst({ where: { id, companyId } });
    case "NE":
      return prisma.payrollDocument.findFirst({ where: { id, companyId } });
    case "NE_ADJUSTMENT":
      return prisma.payrollAdjustment.findFirst({ where: { id, companyId } });
  }
}

function findAnyDocumentRecord(documentType: NumberedDocumentType, companyId: string, id: string) {
  switch (documentType) {
    case "01":
      return prisma.invoice.findFirst({ where: { id, companyId } });
    case "91":
      return prisma.creditNote.findFirst({ where: { id, companyId } });
    case "92":
      return prisma.debitNote.findFirst({ where: { id, companyId } });
    case "05":
      return prisma.supportDocument.findFirst({ where: { id, companyId } });
    case "NE":
      return prisma.payrollDocument.findFirst({ where: { id, companyId } });
  }
}

/**
 * Fetches the raw DIAN SOAP response actually stored for a document (see
 * documentSend.service.ts and this file's own refreshDocumentStatus for
 * where dianResponseReference/RawResponseStore get written) - the only way
 * to see why DIAN rejected something when statusDescription/errorMessage
 * came back empty (which does happen for a genuine rejection, not just a
 * bug - see the 2026-09-08 incident this was built for).
 */
export interface GetDianRawResponseParams {
  companyId: string;
  documentType: NumberedDocumentType;
  id: string;
}

export async function getDianRawResponse(params: GetDianRawResponseParams) {
  const record = await findAnyDocumentRecord(params.documentType, params.companyId, params.id);
  if (!record) {
    throw new Error(`Document ${params.id} (type ${params.documentType}) not found for company ${params.companyId}`);
  }
  if (!record.dianResponseReference) {
    throw new Error(`Document ${params.id} has no raw DIAN response stored (sent before this feature existed, or never actually sent).`);
  }
  return createDefaultRawResponseStore().get(record.dianResponseReference);
}

interface DocumentStatusUpdate {
  status?: "ACCEPTED" | "REJECTED";
  statusDescription: string | null;
  dianResponseReference?: string | null;
  acceptedAt?: Date | null;
  rejectedAt?: Date | null;
  errorMessage?: string | null;
}

function updateDocumentRecord(documentType: RefreshableDocumentType, id: string, data: DocumentStatusUpdate) {
  switch (documentType) {
    case "01":
      return prisma.invoice.update({ where: { id }, data });
    case "91":
      return prisma.creditNote.update({ where: { id }, data });
    case "92":
      return prisma.debitNote.update({ where: { id }, data });
    case "NE":
      return prisma.payrollDocument.update({ where: { id }, data });
    case "NE_ADJUSTMENT":
      return prisma.payrollAdjustment.update({ where: { id }, data });
  }
}

export interface TestSubmission {
  documentType: "01" | "91" | "92" | "05";
  id: string;
  internalReference: string;
  documentNumber: string | null;
  testSetId: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  /** Null only for documents created before certificateId existed on this row, if any predate this field. */
  certificateId: string | null;
  /** "firmapass" | "viafirma" - null only if the certificate row was later deleted (e.g. a rejected Viafirma request cleanup - see viafirmaIssuance.job.ts). */
  certificateProvider: string | null;
  certificateIdentifier: string | null;
}

/**
 * Every invoice/credit-note/debit-note/support-document a company has sent,
 * across all four document types, newest first — optionally narrowed to one
 * `testSetId`. There is no hardcoded checklist of what DIAN requires for a
 * given habilitación round here (that lives only on DIAN's own habilitación
 * portal, and changes per-round) - this exists so an admin can pull "here is
 * everything we actually submitted under testSetId X, and its outcome" and
 * cross-check it against that portal by hand, instead of having no record
 * at all of what was tried.
 */
export async function listTestSubmissions(companyId: string, testSetId?: string): Promise<TestSubmission[]> {
  const where = testSetId ? { companyId, testSetId } : { companyId, testSetId: { not: null } };

  const [invoices, creditNotes, debitNotes, supportDocuments] = await Promise.all([
    prisma.invoice.findMany({ where, include: { certificate: true } }),
    prisma.creditNote.findMany({ where, include: { certificate: true } }),
    prisma.debitNote.findMany({ where, include: { certificate: true } }),
    prisma.supportDocument.findMany({ where, include: { certificate: true } }),
  ]);

  const submissions: TestSubmission[] = [
    ...invoices.map((r) => ({ documentType: "01" as const, id: r.id, internalReference: r.internalReference, documentNumber: r.invoiceNumber, testSetId: r.testSetId, status: r.status, errorMessage: r.errorMessage, createdAt: r.createdAt, certificateId: r.certificateId, certificateProvider: r.certificate?.provider ?? null, certificateIdentifier: r.certificate?.certificateIdentifier ?? null })),
    ...creditNotes.map((r) => ({ documentType: "91" as const, id: r.id, internalReference: r.internalReference, documentNumber: r.noteNumber, testSetId: r.testSetId, status: r.status, errorMessage: r.errorMessage, createdAt: r.createdAt, certificateId: r.certificateId, certificateProvider: r.certificate?.provider ?? null, certificateIdentifier: r.certificate?.certificateIdentifier ?? null })),
    ...debitNotes.map((r) => ({ documentType: "92" as const, id: r.id, internalReference: r.internalReference, documentNumber: r.noteNumber, testSetId: r.testSetId, status: r.status, errorMessage: r.errorMessage, createdAt: r.createdAt, certificateId: r.certificateId, certificateProvider: r.certificate?.provider ?? null, certificateIdentifier: r.certificate?.certificateIdentifier ?? null })),
    ...supportDocuments.map((r) => ({ documentType: "05" as const, id: r.id, internalReference: r.internalReference, documentNumber: r.documentNumber, testSetId: r.testSetId, status: r.status, errorMessage: r.errorMessage, createdAt: r.createdAt, certificateId: r.certificateId, certificateProvider: r.certificate?.provider ?? null, certificateIdentifier: r.certificate?.certificateIdentifier ?? null })),
  ];

  return submissions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface LookupAcquirerParams {
  companyId: string;
  identificationType: string;
  identificationNumber: string;
  /**
   * Which DIAN registry to ask. Defaults to the company's own environment,
   * but Ohnix asks PRODUCTION: habilitación only knows test data, so a real
   * person is "not found" there.
   */
  environment?: "PRODUCTION" | "SANDBOX";
}

/**
 * DIAN's GetAcquirer for one NIT/cédula: the registered name and e-invoice
 * reception email. Consumed by Ohnix's "buscar tercero" (customer/supplier
 * form autocomplete). Only needs this company's certificate + environment -
 * unlike loadDianConfig, no numbering resolution - so any company with an
 * ACTIVE certificate can answer it, habilitada or not.
 *
 * Always the real DianKitProvider, even in dianSimulationMode: it's a
 * read-only query (nothing is issued), and SimulatedDianProvider
 * deliberately refuses it rather than invent registry data.
 */
export async function lookupAcquirer(params: LookupAcquirerParams) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: params.companyId },
    include: { dianConfiguration: true },
  });
  if (!company.dianConfiguration) {
    throw new Error(`Company ${params.companyId} has no DianConfiguration`);
  }
  const certificate = await findSigningCertificate(company);
  const secret = await createDefaultCertificateSecretStore().get(certificate.secretReference);
  // DianKit's constructor only loads the .p12; supplier/software/numbering
  // are never touched by lookupBuyer, so they're left out on purpose.
  const config = {
    certificate: secret.p12,
    certificatePassword: secret.password,
    environment:
      (params.environment ?? company.dianConfiguration.environment) === "PRODUCTION" ? "1" : "2",
  } as unknown as DianKitConfig;
  let result;
  try {
    result = await new DianKitProvider(config).lookupBuyer({
      identificationType: params.identificationType,
      identificationNumber: params.identificationNumber,
    });
  } catch (error) {
    // The DIAN answers an unknown party with a bare HTTP 404 rather than a
    // StatusCode in the body - that's "not found", not a failure.
    if ((error as { statusCode?: number }).statusCode === 404) {
      return { receiverName: "", receiverEmail: "", statusCode: "404", message: "DIAN: adquirente no encontrado" };
    }
    throw error;
  }
  return {
    receiverName: result.receiverName,
    receiverEmail: result.receiverEmail,
    statusCode: result.statusCode,
    message: result.message,
  };
}

export interface DianNumberingRangeSummary {
  authorizationNumber: string;
  prefix: string;
  fromNumber: number;
  toNumber: number;
  startDate: string;
  endDate: string;
  /** Whether DIAN sent a technical key for this range - the key itself never leaves this service. */
  hasTechnicalKey: boolean;
  /** Today is inside startDate..endDate. */
  isCurrent: boolean;
  /** A NumberingResolution with this prefix already exists for the company. */
  alreadyLoaded: boolean;
}

export interface DianNumberingRangesResult {
  /** DIAN's OperationCode/OperationDescription, verbatim (e.g. "100" / a "no ranges" message). */
  operationCode: string | null;
  operationDescription: string | null;
  ranges: DianNumberingRangeSummary[];
}

const textOf = (rawXml: string, tag: string): string | null => {
  const match = rawXml.match(new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}[^>]*>([^<]*)</(?:[A-Za-z0-9_]+:)?${tag}>`));
  return match ? match[1]!.trim() : null;
};

/**
 * DIAN's GetNumberingRange for this company's own software (software propio:
 * the company's NIT is both accountCode and accountCodeT): every numbering
 * range DIAN has associated to that NIT + softwareId, with its technical key.
 * This is what the real "01" resolution and production technical key must
 * match - reading it straight from DIAN replaces hand-typing the formato 1876
 * (a typed-in "1" instead of 18760000001 cost marhoma a rejected test set).
 *
 * Always asks PRODUCTION, like lookupAcquirer: real resolutions only exist
 * there, and a prefix associated to the software in the catálogo shows up
 * there whether or not this company's own environment was flipped yet. Only
 * needs the certificate + softwareId, no numbering resolution. Always the
 * real DianKitProvider, even in dianSimulationMode - read-only, nothing issued.
 */
async function fetchDianNumberingRanges(companyId: string) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { dianConfiguration: true, numberingResolutions: { select: { prefix: true } } },
  });
  if (!company.dianConfiguration?.softwareId) {
    throw new Error(`Company ${companyId} has no DianConfiguration/softwareId`);
  }
  const certificate = await findSigningCertificate(company);
  const secret = await createDefaultCertificateSecretStore().get(certificate.secretReference);
  // DianKit's constructor only loads the .p12; getNumberingRange reads just
  // supplier.identification.number and software.id on top of it.
  const config = {
    certificate: secret.p12,
    certificatePassword: secret.password,
    environment: "1",
    supplier: { identification: { number: company.nit } },
    software: { id: company.dianConfiguration.softwareId },
  } as unknown as DianKitConfig;
  const provider = new DianKitProvider(config);
  // Read-only, so a network blip (seen: a router DNS refusing ~1 in 5
  // lookups of vpfe.dian.gov.co) is safe to retry once instead of failing.
  let response;
  try {
    response = await provider.getNumberingRange(company.nit);
  } catch (error) {
    if (!(error instanceof DianTransportError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await provider.getNumberingRange(company.nit);
  }
  return { company, response };
}

export async function queryDianNumberingRanges(companyId: string): Promise<DianNumberingRangesResult> {
  const { company, response } = await fetchDianNumberingRanges(companyId);
  const today = new Date().toISOString().slice(0, 10);
  const loadedPrefixes = new Set(company.numberingResolutions.map((resolution) => resolution.prefix.toUpperCase()));
  const operationCode = textOf(response.rawResponse, "OperationCode");
  // DIAN said OK but nothing was parsed: the response shape isn't what the
  // parser knows (that is how the first real answer came back empty). Log it
  // with technical keys blanked so the shape can be fixed from the log.
  if (operationCode === "100" && response.ranges.length === 0) {
    console.warn(
      `[dian-numbering-ranges] DIAN answered OK with no parsed ranges for company ${companyId}:`,
      response.rawResponse.replace(/(TechnicalKey>)[^<]*(<)/g, "$1***$2"),
    );
  }
  return {
    operationCode,
    operationDescription: textOf(response.rawResponse, "OperationDescription"),
    ranges: response.ranges.map((range) => ({
      authorizationNumber: range.authorizationNumber,
      prefix: range.prefix,
      fromNumber: range.fromNumber,
      toNumber: range.toNumber,
      startDate: range.startDate,
      endDate: range.endDate,
      hasTechnicalKey: Boolean(range.technicalKey),
      isCurrent: Boolean(range.startDate && range.endDate && range.startDate.slice(0, 10) <= today && range.endDate.slice(0, 10) >= today),
      alreadyLoaded: loadedPrefixes.has(range.prefix.toUpperCase()),
    })),
  };
}

export interface ApplyDianNumberingRangeParams {
  companyId: string;
  prefix: string;
  authorizationNumber: string;
}

/**
 * Loads one of DIAN's own ranges (see queryDianNumberingRanges) as the
 * company's "01" NumberingResolution, then stores its technical key on
 * DianConfiguration (a failure in between leaves the resolution loaded with
 * the old key; retrying is safe - see below). Re-queries DIAN instead of
 * trusting anything the caller sends beyond which range it picked, so the
 * stored resolution and key are exactly DIAN's. Meant to run right before
 * the SANDBOX -> PRODUCTION flip (setDianEnvironment): the technical key
 * is company-wide, and once replaced, habilitación test sends no longer
 * match DIAN's test key.
 *
 * Idempotent on the prefix: if a resolution with it already exists (e.g. a
 * retried activation), it's left alone when it already matches DIAN, and
 * otherwise corrected in place through updateNumberingResolution's own lock
 * instead of creating a duplicate.
 */
export async function applyDianNumberingRange(params: ApplyDianNumberingRangeParams) {
  const { response } = await fetchDianNumberingRanges(params.companyId);
  const prefix = params.prefix.trim().toUpperCase();
  const range = response.ranges.find(
    (candidate) => candidate.prefix.toUpperCase() === prefix && candidate.authorizationNumber === params.authorizationNumber.trim(),
  );
  if (!range) {
    throw new Error(`DIAN has no numbering range ${prefix} / ${params.authorizationNumber} for company ${params.companyId}'s software`);
  }
  if (!range.technicalKey) {
    throw new Error(`DIAN returned no technical key for range ${prefix} / ${range.authorizationNumber}`);
  }

  const resolutionFields = {
    prefix: range.prefix,
    resolutionNumber: range.authorizationNumber,
    startNumber: range.fromNumber,
    endNumber: range.toNumber,
    startDate: range.startDate,
    endDate: range.endDate,
  };
  const existing = await prisma.numberingResolution.findUnique({
    where: { companyId_prefix: { companyId: params.companyId, prefix: range.prefix } },
  });
  const sameAsDian = existing
    && existing.documentType === "01"
    && existing.resolutionNumber === resolutionFields.resolutionNumber
    && existing.startNumber === resolutionFields.startNumber
    && existing.endNumber === resolutionFields.endNumber
    && existing.startDate.toISOString().slice(0, 10) === resolutionFields.startDate.slice(0, 10)
    && existing.endDate.toISOString().slice(0, 10) === resolutionFields.endDate.slice(0, 10);
  if (existing && existing.documentType !== "01") {
    throw new Error(`Prefix ${range.prefix} is already used by a "${existing.documentType}" resolution for company ${params.companyId}`);
  }
  const resolution = !existing
    ? await createNumberingResolution({ companyId: params.companyId, documentType: "01", ...resolutionFields })
    : sameAsDian
      ? existing
      : await updateNumberingResolution({ companyId: params.companyId, resolutionId: existing.id, ...resolutionFields });

  await prisma.dianConfiguration.update({
    where: { companyId: params.companyId },
    data: { technicalKey: range.technicalKey },
  });

  return {
    resolution: {
      id: resolution.id,
      documentType: resolution.documentType,
      prefix: resolution.prefix,
      resolutionNumber: resolution.resolutionNumber,
      startNumber: resolution.startNumber,
      endNumber: resolution.endNumber,
      startDate: resolution.startDate,
      endDate: resolution.endDate,
    },
    technicalKeyUpdated: true,
  };
}

