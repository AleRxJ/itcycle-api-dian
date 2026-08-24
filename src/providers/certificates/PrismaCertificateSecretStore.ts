import type { PrismaClient } from "@prisma/client";

import { aesGcmDecrypt, aesGcmEncrypt, parseAesGcmKey } from "../../shared/aesGcmCipher.js";
import type { CertificateSecret, CertificateSecretStore } from "./CertificateSecretStore.js";

/**
 * Postgres-backed {@link CertificateSecretStore} (via Prisma's
 * CertificateSecretBlob table), encrypting everything at rest with
 * AES-256-GCM before it ever reaches the database — same encryption as
 * {@link EncryptedFileCertificateSecretStore}, just persisted as `bytea`
 * rows instead of files.
 *
 * For deployments without a persistent disk (e.g. Render's free tier, where
 * local disk is wiped on every restart/redeploy) — see STORAGE_DRIVER in
 * src/shared/env.ts.
 */
export class PrismaCertificateSecretStore implements CertificateSecretStore {
  private readonly masterKey: Buffer;

  constructor(
    private readonly prisma: PrismaClient,
    masterKeyBase64Url: string,
  ) {
    this.masterKey = parseAesGcmKey(masterKeyBase64Url, "CERTIFICATE_ENCRYPTION_KEY");
  }

  async save(secretReference: string, secret: CertificateSecret): Promise<void> {
    const p12Ciphertext = Buffer.from(aesGcmEncrypt(this.masterKey, secret.p12));
    const passwordCiphertext = Buffer.from(aesGcmEncrypt(this.masterKey, Buffer.from(secret.password, "utf-8")));
    await this.prisma.certificateSecretBlob.upsert({
      where: { reference: secretReference },
      create: { reference: secretReference, p12Ciphertext, passwordCiphertext },
      update: { p12Ciphertext, passwordCiphertext },
    });
  }

  async get(secretReference: string): Promise<CertificateSecret> {
    const row = await this.prisma.certificateSecretBlob.findUniqueOrThrow({
      where: { reference: secretReference },
    });
    return {
      p12: aesGcmDecrypt(this.masterKey, Buffer.from(row.p12Ciphertext)),
      password: aesGcmDecrypt(this.masterKey, Buffer.from(row.passwordCiphertext)).toString("utf-8"),
    };
  }

  async delete(secretReference: string): Promise<void> {
    await this.prisma.certificateSecretBlob.deleteMany({ where: { reference: secretReference } });
  }
}
