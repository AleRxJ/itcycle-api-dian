import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { aesGcmDecrypt, aesGcmEncrypt, parseAesGcmKey } from "../../shared/aesGcmCipher.js";
import type { CertificateSecret, CertificateSecretStore } from "./CertificateSecretStore.js";

/**
 * Filesystem-backed {@link CertificateSecretStore} that encrypts everything
 * at rest with AES-256-GCM before it ever touches disk. The default store
 * for production document services (see invoice/creditNote/debitNote
 * .service.ts) — replaces {@link LocalFileCertificateSecretStore}'s
 * plaintext files, which stay around only as a dev/test double.
 *
 * `masterKey` must be exactly 32 raw bytes. Losing it means every stored
 * certificate becomes unrecoverable — treat it like the certificates
 * themselves (secret manager, never checked into git, rotated deliberately).
 */
export class EncryptedFileCertificateSecretStore implements CertificateSecretStore {
  private readonly masterKey: Buffer;

  constructor(
    private readonly baseDir: string,
    masterKeyBase64Url: string,
  ) {
    this.masterKey = parseAesGcmKey(masterKeyBase64Url, "CERTIFICATE_ENCRYPTION_KEY");
  }

  async save(secretReference: string, secret: CertificateSecret): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.p12Path(secretReference), aesGcmEncrypt(this.masterKey, secret.p12));
    await writeFile(
      this.passwordPath(secretReference),
      aesGcmEncrypt(this.masterKey, Buffer.from(secret.password, "utf-8")),
    );
  }

  async get(secretReference: string): Promise<CertificateSecret> {
    const [p12Encrypted, passwordEncrypted] = await Promise.all([
      readFile(this.p12Path(secretReference)),
      readFile(this.passwordPath(secretReference)),
    ]);
    return {
      p12: aesGcmDecrypt(this.masterKey, p12Encrypted),
      password: aesGcmDecrypt(this.masterKey, passwordEncrypted).toString("utf-8"),
    };
  }

  async delete(secretReference: string): Promise<void> {
    await Promise.all([
      rm(this.p12Path(secretReference), { force: true }),
      rm(this.passwordPath(secretReference), { force: true }),
    ]);
  }

  private p12Path(secretReference: string): string {
    return join(this.baseDir, `${secretReference}.p12.enc`);
  }

  private passwordPath(secretReference: string): string {
    return join(this.baseDir, `${secretReference}.password.enc`);
  }
}
