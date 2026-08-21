import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  /** Local directory for LocalFileCertificateSecretStore. Dev only — see docs/certificates/. */
  certificatesDir: process.env.CERTIFICATES_DIR ?? "./certs",
  /** Shared secret protecting the dev-only /api/v1/dian/* routes. */
  devApiKey: process.env.DEV_API_KEY,
};
