import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CertificateSecret, CertificateSecretStore } from "./CertificateSecretStore.js";

/**
 * Filesystem-backed {@link CertificateSecretStore} for local development
 * only. Stores each certificate as `<baseDir>/<ref>.p12` plus a sibling
 * `<baseDir>/<ref>.password` plaintext file.
 *
 * NEVER use this in production. `baseDir` must stay outside of git (see
 * `.gitignore`) — swap this class for a Vault/KMS/HSM-backed implementation
 * of the same interface when deploying for real.
 */
export class LocalFileCertificateSecretStore implements CertificateSecretStore {
  constructor(private readonly baseDir: string) {}

  async save(secretReference: string, secret: CertificateSecret): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.p12Path(secretReference), secret.p12);
    await writeFile(this.passwordPath(secretReference), secret.password, "utf-8");
  }

  async get(secretReference: string): Promise<CertificateSecret> {
    const [p12, password] = await Promise.all([
      readFile(this.p12Path(secretReference)),
      readFile(this.passwordPath(secretReference), "utf-8"),
    ]);
    return { p12, password: password.trim() };
  }

  async delete(secretReference: string): Promise<void> {
    await Promise.all([
      rm(this.p12Path(secretReference), { force: true }),
      rm(this.passwordPath(secretReference), { force: true }),
    ]);
  }

  private p12Path(secretReference: string): string {
    return join(this.baseDir, `${secretReference}.p12`);
  }

  private passwordPath(secretReference: string): string {
    return join(this.baseDir, `${secretReference}.password`);
  }
}
