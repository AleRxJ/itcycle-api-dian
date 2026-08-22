import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  /** Local directory for LocalFileCertificateSecretStore. Dev only — see docs/certificates/. */
  certificatesDir: process.env.CERTIFICATES_DIR ?? "./certs",
  /** Shared secret protecting the dev-only /api/v1/dian/* routes. */
  devApiKey: process.env.DEV_API_KEY,
  /**
   * When true, test-invoice uses SimulatedDianProvider instead of the real
   * DianKitProvider: dian-kit still builds/signs the real document, but the
   * DIAN send is a canned local response. See docs/dian/simulation.md.
   * NEVER a substitute for a real DIAN Sandbox test — dev/demo only.
   */
  dianSimulationMode: process.env.DIAN_SIMULATION_MODE === "true",
};
