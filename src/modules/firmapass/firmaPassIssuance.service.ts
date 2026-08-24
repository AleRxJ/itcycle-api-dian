import { randomUUID } from "node:crypto";

import { prisma } from "../../infrastructure/prisma.js";
import { FirmaPassClient } from "../../providers/firmapass/FirmaPassClient.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { decryptSecret, encryptSecret } from "../../shared/secretEncryption.js";

export async function setFirmaPassLoginKey(companyId: string, loginKey: string): Promise<void> {
  await prisma.company.update({
    where: { id: companyId },
    data: { firmaPassLoginKeyCiphertext: encryptSecret(loginKey) },
  });
}

async function getClientForCompany(companyId: string): Promise<FirmaPassClient> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  if (!company.firmaPassLoginKeyCiphertext) {
    throw new Error(`Company ${companyId} has no FirmaPass login key configured`);
  }
  return new FirmaPassClient(decryptSecret(company.firmaPassLoginKeyCiphertext));
}

export interface UploadRutParams {
  companyId: string;
  validationUuid: string;
  rutBase64: string;
  identificacionRepresentanteLegal?: string;
}

export async function uploadRut(params: UploadRutParams) {
  const client = await getClientForCompany(params.companyId);
  return client.uploadRut(params.validationUuid, {
    rutBase64: params.rutBase64,
    identificacionRepresentanteLegal: params.identificacionRepresentanteLegal,
  });
}

export interface UploadArchivoParams {
  companyId: string;
  validationUuid: string;
  type: string;
  fileBase64: string;
}

export async function uploadArchivo(params: UploadArchivoParams) {
  const client = await getClientForCompany(params.companyId);
  return client.uploadArchivo(params.validationUuid, { type: params.type, fileBase64: params.fileBase64 });
}

export interface ConfirmValidationParams {
  companyId: string;
  validationUuid: string;
}

export interface ConfirmValidationResult {
  certificateId: string;
  certificateIdentifier: string;
  estado: string;
}

/**
 * Confirms a FirmaPass identity validation and creates the corresponding
 * Certificate row. Real certificate issuance is asynchronous — this only
 * gets as far as FirmaPass's "en espera" state ("pe");
 * src/jobs/firmaPassIssuance.job.ts polls FirmaPass afterwards and finalizes
 * the row (status ACTIVE, real expiresAt, real PKCS12) once the certificate
 * reaches estado "v".
 *
 * Non-centralized signing only: throws if FirmaPass returns
 * `private_key_pem: null` (centralized mode) — not supported yet. The raw
 * PEM is stashed into the existing CertificateSecretStore (`p12` slot, empty
 * password as a documented "bare PEM, not yet a real PKCS12" sentinel)
 * immediately, before this function returns anything — and is never logged,
 * here or in any catch block downstream.
 */
export async function confirmValidation(params: ConfirmValidationParams): Promise<ConfirmValidationResult> {
  const client = await getClientForCompany(params.companyId);
  const response = await client.confirmar(params.validationUuid);

  if (response.private_key_pem === null) {
    throw new Error(
      "FirmaPass returned a centralized-signature certificate (private_key_pem is null). " +
        "Centralized signing is not supported yet — confirm with FirmaPass that non-centralized " +
        "mode is available for this certificate type before retrying.",
    );
  }

  const secretStore = createDefaultCertificateSecretStore();
  const secretReference = randomUUID();
  await secretStore.save(secretReference, {
    p12: Buffer.from(response.private_key_pem, "utf-8"),
    password: "",
  });

  const certificate = await prisma.certificate.create({
    data: {
      companyId: params.companyId,
      provider: "firmapass",
      certificateIdentifier: response.certificate.identificador,
      secretReference,
      expiresAt: null,
      status: "INACTIVE",
    },
  });

  return {
    certificateId: certificate.id,
    certificateIdentifier: certificate.certificateIdentifier,
    estado: response.certificate.estado,
  };
}
