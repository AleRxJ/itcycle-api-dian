import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CertificateSecret, CertificateSecretStore } from "./CertificateSecretStore.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit, standard for GCM
const KEY_LENGTH = 32; // AES-256

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
    const key = Buffer.from(masterKeyBase64Url, "base64url");
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `CERTIFICATE_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}). ` +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
      );
    }
    this.masterKey = key;
  }

  async save(secretReference: string, secret: CertificateSecret): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.p12Path(secretReference), this.encrypt(secret.p12));
    await writeFile(this.passwordPath(secretReference), this.encrypt(Buffer.from(secret.password, "utf-8")));
  }

  async get(secretReference: string): Promise<CertificateSecret> {
    const [p12Encrypted, passwordEncrypted] = await Promise.all([
      readFile(this.p12Path(secretReference)),
      readFile(this.passwordPath(secretReference)),
    ]);
    return {
      p12: this.decrypt(p12Encrypted),
      password: this.decrypt(passwordEncrypted).toString("utf-8"),
    };
  }

  async delete(secretReference: string): Promise<void> {
    await Promise.all([
      rm(this.p12Path(secretReference), { force: true }),
      rm(this.passwordPath(secretReference), { force: true }),
    ]);
  }

  /** Layout: [12-byte IV][16-byte auth tag][ciphertext] — everything needed to decrypt, nothing that reveals the plaintext. */
  private encrypt(plaintext: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(payload: Buffer): Buffer {
    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + 16);
    const ciphertext = payload.subarray(IV_LENGTH + 16);
    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  private p12Path(secretReference: string): string {
    return join(this.baseDir, `${secretReference}.p12.enc`);
  }

  private passwordPath(secretReference: string): string {
    return join(this.baseDir, `${secretReference}.password.enc`);
  }
}
