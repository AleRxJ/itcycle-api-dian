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
  /**
   * iTCycle's OWN FirmaPass "alianza" login key — ONE account shared across
   * every provisioned company, not a per-company credential. A client's
   * certificate purchase (made on FirmaPass's own site with iTCycle's
   * coupon) auto-attaches to this alliance account, so a client never has a
   * FirmaPass login key of their own to give us. See
   * modules/firmapass/firmaPassIssuance.service.ts.
   */
  firmaPassAllianceLoginKey: process.env.FIRMAPASS_ALLIANCE_LOGIN_KEY,
  /**
   * FirmaPass API host. Defaults to production (identidad.firmapass.com).
   * FirmaPass's sandbox environment (identidad-sandbox.firmapass.com) uses a
   * separate account and login key from production - never mix a sandbox
   * key with the production URL or vice versa (they don't authenticate
   * against each other). Override for local development only.
   */
  firmaPassBaseUrl: process.env.FIRMAPASS_BASE_URL || "https://identidad.firmapass.com",

  // --- Viafirma Colombia (PKCS#10 RA API) -----------------------------
  // See src/providers/certificates/ViafirmaCertificateProvider.ts and
  // CertificateProviderRegistry.ts. Master rollout switch: false until the
  // Sandbox integration (Fase 3) is validated end-to-end — see
  // "Uso del API para perfiles PKCS#10 v1.7" §2.1 for the credentials this
  // unlocks.
  /** Master on/off switch, independent of PRIMARY_PROVIDER — lets Viafirma be configured but dark during rollout. */
  viafirmaEnabled: process.env.VIAFIRMA_ENABLED === "true",
  /** "viafirma" (target end state) or "firmapass" (current state, and the safe default while VIAFIRMA_ENABLED=false). */
  certificatePrimaryProvider: (process.env.PRIMARY_PROVIDER === "viafirma" ? "viafirma" : "firmapass") as
    | "viafirma"
    | "firmapass",
  /** Provider to retry a NEW-request technical failure against — see CertificateProviderRegistry.fallbackForNewRequestFailure. Empty/unset disables fallback regardless of certificateFallbackEnabled. */
  certificateFallbackProvider: (process.env.FALLBACK_PROVIDER === "viafirma"
    ? "viafirma"
    : process.env.FALLBACK_PROVIDER === "firmapass"
      ? "firmapass"
      : null) as "viafirma" | "firmapass" | null,
  /** Default true (matches the brief's "FALLBACK_ENABLED=true" example) — set false to force PRIMARY_PROVIDER only, e.g. while diagnosing a Viafirma-specific issue without FirmaPass silently absorbing failures. */
  certificateFallbackEnabled: process.env.FALLBACK_ENABLED !== "false",
  /**
   * https://sandbox.viafirma.com/ra/api/v2 (default) or
   * https://ecd.viafirma.com/ra/api/v2 for Production — §2.1. Never mix a
   * Sandbox Consumer Key/Secret with the Production URL or vice versa
   * (same non-interop warning as FirmaPass's own sandbox/production split).
   */
  viafirmaBaseUrl: process.env.VIAFIRMA_BASE_URL || "https://sandbox.viafirma.com/ra/api/v2",
  /**
   * Download host for §2.3.5 (`{{urlRADescarga}}` in the Postman
   * collection) — REQUIERE_CONFIRMACION_VIAFIRMA: the exact Sandbox/
   * Production value for this host is not spelled out in the PDF text
   * itself, only implied by the Postman variable name. Confirm with
   * Viafirma/their Postman environment file before Fase 3 goes live.
   */
  viafirmaDownloadBaseUrl: process.env.VIAFIRMA_DOWNLOAD_BASE_URL,
  /** OAuth 1.0 (HMAC-SHA1) Consumer Key — §2.1. Backend-only; never expose to Frontend. */
  viafirmaConsumerKey: process.env.VIAFIRMA_CONSUMER_KEY,
  /** OAuth 1.0 (HMAC-SHA1) Consumer Secret — §2.1. Backend-only; never expose to Frontend, never logged. */
  viafirmaConsumerSecret: process.env.VIAFIRMA_CONSUMER_SECRET,
  /** RA code, e.g. "viafirmaco" — §2.3.1 `ra` query param. */
  viafirmaRa: process.env.VIAFIRMA_RA || "viafirmaco",
  /** Cron expression for how often pending Viafirma certificate issuances are polled — see src/jobs/viafirmaIssuance.job.ts. Default: every 10 minutes, matching FIRMAPASS_ISSUANCE_CRON. */
  viafirmaIssuanceCron: process.env.VIAFIRMA_ISSUANCE_CRON ?? "*/10 * * * *",
};
