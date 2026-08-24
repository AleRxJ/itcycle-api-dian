import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  /** Local directory for the certificate secret store (encrypted or plaintext, see certificateStore.ts). */
  certificatesDir: process.env.CERTIFICATES_DIR ?? "./certs",
  /** Local directory for LocalFileDocumentXmlStore (signed document XML — not a secret, but never in git). */
  documentsDir: process.env.DOCUMENTS_DIR ?? "./documents",
  /**
   * "file" (default) uses CERTIFICATES_DIR/DOCUMENTS_DIR on local disk —
   * fine for a host with a persistent disk, wrong for one without (e.g.
   * Render's free tier, where disk is wiped on every restart/redeploy).
   * "database" persists certificates/XML as rows in Postgres instead (see
   * PrismaCertificateSecretStore / PrismaDocumentXmlStore) — no extra
   * infrastructure needed beyond DATABASE_URL, at the cost of growing the
   * app's own database with binary/XML blobs.
   */
  storageDriver: process.env.STORAGE_DRIVER === "database" ? "database" : "file",
  /** Shared secret protecting the dev-only /api/v1/dian/* routes. */
  devApiKey: process.env.DEV_API_KEY,
  /**
   * Shared secret protecting /api/v1/admin/* (tenant provisioning: create
   * Company, set DianConfiguration, register NumberingResolution, upload
   * Certificate, issue ApiKey). Deliberately separate from DEV_API_KEY: this
   * is meant to be called only by Ohnix's own backend, never a customer or
   * a dev-only manual test — see src/shared/adminAuth.ts.
   */
  adminApiKey: process.env.ADMIN_API_KEY,
  /**
   * 32-byte key (base64url) encrypting certificates at rest via
   * EncryptedFileCertificateSecretStore. Unset falls back to the plaintext
   * LocalFileCertificateSecretStore — fine for local dev, never for a real
   * deployment. See src/shared/certificateStore.ts.
   */
  certificateEncryptionKey: process.env.CERTIFICATE_ENCRYPTION_KEY,
  /**
   * When true, test-invoice uses SimulatedDianProvider instead of the real
   * DianKitProvider: dian-kit still builds/signs the real document, but the
   * DIAN send is a canned local response. See docs/dian/simulation.md.
   * NEVER a substitute for a real DIAN Sandbox test — dev/demo only.
   */
  dianSimulationMode: process.env.DIAN_SIMULATION_MODE === "true",
  /** Master on/off switch for the contingency-retry cron job (src/jobs/contingencyRetry.job.ts). Default on. */
  startScheduler: process.env.START_SCHEDULER !== "false",
  /** Cron expression for how often CONTINGENCY documents are automatically retried. Default: every 10 minutes. */
  contingencyRetryCron: process.env.CONTINGENCY_RETRY_CRON ?? "*/10 * * * *",
  /**
   * 32-byte key (base64url) encrypting Company.firmaPassLoginKeyCiphertext at
   * rest — see src/shared/secretEncryption.ts. Deliberately separate from
   * CERTIFICATE_ENCRYPTION_KEY (different secret category, never share a key
   * across categories).
   */
  firmaPassEncryptionKey: process.env.FIRMAPASS_ENCRYPTION_KEY,
  /** Cron expression for how often pending FirmaPass certificate issuances are polled. Default: every 10 minutes. */
  firmaPassIssuanceCron: process.env.FIRMAPASS_ISSUANCE_CRON ?? "*/10 * * * *",
};
