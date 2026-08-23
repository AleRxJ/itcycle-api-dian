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
  documentType: "01" | "91" | "92";
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
