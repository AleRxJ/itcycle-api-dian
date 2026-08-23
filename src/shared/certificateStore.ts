import { EncryptedFileCertificateSecretStore } from "../providers/certificates/EncryptedFileCertificateSecretStore.js";
import { LocalFileCertificateSecretStore } from "../providers/certificates/LocalFileCertificateSecretStore.js";
import type { CertificateSecretStore } from "../providers/certificates/CertificateSecretStore.js";
import { env } from "./env.js";

/**
 * Default CertificateSecretStore for the production document services
 * (invoice/creditNote/debitNote .service.ts). Encrypted-at-rest when
 * CERTIFICATE_ENCRYPTION_KEY is configured; falls back to the plaintext
 * LocalFileCertificateSecretStore otherwise — fine for local
 * development/SIMULATE testing, but a real deployment must set the key.
 *
 * Evaluated lazily (called per-invocation, never stored in a module-level
 * constant) so importing a service module never fails just because the env
 * var isn't set — tests inject their own secretStore and never hit this.
 */
export function createDefaultCertificateSecretStore(): CertificateSecretStore {
  if (env.certificateEncryptionKey) {
    return new EncryptedFileCertificateSecretStore(env.certificatesDir, env.certificateEncryptionKey);
  }
  return new LocalFileCertificateSecretStore(env.certificatesDir);
}
