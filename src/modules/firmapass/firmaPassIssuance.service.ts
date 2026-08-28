import { randomUUID } from "node:crypto";

import { prisma } from "../../infrastructure/prisma.js";
import { FirmaPassClient } from "../../providers/firmapass/FirmaPassClient.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { env } from "../../shared/env.js";

/**
 * iTCycle's own FirmaPass "alianza" account — ONE login key shared across
 * every provisioned company, not a per-company credential. Per FirmaPass:
 * a client's certificate purchase (made on FirmaPass's own site with
 * iTCycle's coupon) auto-attaches to this alliance account, so a client
 * never has — and is never asked for — a FirmaPass login key of their own.
 * Company.firmaPassLoginKeyCiphertext (kept in the schema, no longer
 * written) is the old, incorrect per-company model this replaces.
 */
function getAllianceClient(): FirmaPassClient {
  if (!env.firmaPassAllianceLoginKey) {
    throw new Error("FIRMAPASS_ALLIANCE_LOGIN_KEY is not configured");
  }
  return new FirmaPassClient(env.firmaPassAllianceLoginKey, env.firmaPassBaseUrl);
}

export interface UploadRutParams {
  companyId: string;
  validationUuid: string;
  rutBase64: string;
  identificacionRepresentanteLegal?: string;
}

export async function uploadRut(params: UploadRutParams) {
  const client = getAllianceClient();
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
  const client = getAllianceClient();
  return client.uploadArchivo(params.validationUuid, { type: params.type, fileBase64: params.fileBase64 });
}

export interface ListPendingValidationsParams {
  perPage?: number;
  /** Exact match against a real purchase's order number - see FirmaPassClient.listValidations. */
  orderNumber?: string;
}

/** Every validation the alliance account can see (across all clients who bought with the coupon), for an admin to browse/match to an Ohnix company - by `owner_email`/`order_number` when a real purchase set them, otherwise by the generic `nombre` label. */
export async function listPendingValidations(params: ListPendingValidationsParams = {}) {
  return getAllianceClient().listValidations(params);
}

/** FIFO convenience: the oldest validation still waiting on document upload, or null when the queue is empty. */
export async function getNextPendingValidation() {
  return getAllianceClient().getNuevaSolicitud();
}

export async function getValidationDetail(validationUuid: string) {
  return getAllianceClient().getValidationDetail(validationUuid);
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
  const client = getAllianceClient();
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
