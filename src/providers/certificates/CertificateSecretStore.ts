/** A .p12 certificate and its password, held only in memory once retrieved. */
export interface CertificateSecret {
  p12: Buffer;
  password: string;
}

/**
 * Abstraction over wherever certificate private-key material actually lives.
 * `Certificate.secretReference` (see prisma/schema.prisma) is the only thing
 * ITCycle persists in its own database — the secret itself is fetched
 * through this interface at the moment it's needed to sign a document, and
 * never logged or returned by any API response.
 *
 * Meant to be backed by Vault/KMS/Secret Manager/HSM in production. See
 * {@link LocalFileCertificateSecretStore} for the local-development stand-in.
 */
export interface CertificateSecretStore {
  save(secretReference: string, secret: CertificateSecret): Promise<void>;
  get(secretReference: string): Promise<CertificateSecret>;
  delete(secretReference: string): Promise<void>;
}
