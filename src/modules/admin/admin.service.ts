import { randomUUID } from "node:crypto";

import { prisma } from "../../infrastructure/prisma.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { generateApiKey } from "../../shared/apiKeyAuth.js";

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
}

export interface FirmaPassStatus {
  loginKeySet: boolean;
  certificates: FirmaPassStatusCertificate[];
}

export interface DianReadiness {
  canIssueInvoices: boolean;
  environment: "SANDBOX" | "PRODUCTION" | null;
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
    startDate: Date;
    endDate: Date;
    status: string;
    isCurrent: boolean;
  }>;
  certificates: FirmaPassStatusCertificate[];
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
  const activeCertificates = company.certificates.filter((certificate) =>
    certificate.status === "ACTIVE" && (!certificate.expiresAt || certificate.expiresAt >= now),
  );
  const missing: string[] = [];
  if (!configurationReady) missing.push("dian_configuration");
  if (!activeInvoiceResolution) missing.push("invoice_resolution_01");
  if (activeCertificates.length === 0) missing.push("active_certificate");

  return {
    canIssueInvoices: missing.length === 0,
    environment: company.dianConfiguration?.environment ?? null,
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
      startDate: resolution.startDate,
      endDate: resolution.endDate,
      status: resolution.status,
      isCurrent: resolution.status === "ACTIVE" && resolution.startDate <= now && resolution.endDate >= now && resolution.currentNumber <= resolution.endNumber,
    })),
    certificates: company.certificates.map((certificate) => ({
      id: certificate.id,
      certificateIdentifier: certificate.certificateIdentifier,
      status: certificate.status,
      expiresAt: certificate.expiresAt,
      createdAt: certificate.createdAt,
    })),
  };
}

/** Read-only snapshot for Ohnix's admin UI — no schema change, just a projection of existing columns. */
export async function getFirmaPassStatus(companyId: string): Promise<FirmaPassStatus> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const certificates = await prisma.certificate.findMany({
    where: { companyId, provider: "firmapass" },
    orderBy: { createdAt: "desc" },
  });

  return {
    loginKeySet: Boolean(company.firmaPassLoginKeyCiphertext),
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
