import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateKeyPairAndCsr, type ViafirmaCsrSubjectPN } from "../src/providers/certificates/ViafirmaCertificateProvider.js";

/**
 * One-off helper for a manual (outside-the-API) Viafirma Persona Natural
 * certificate request. Uses the exact same generateKeyPairAndCsr the
 * automated flow relies on, so the CSR subject is clean (no stray
 * dnQualifier like the Viafirma RA Cert Desktop tool's own template adds).
 *
 * Run with: pnpm tsx scripts/generate-manual-csr.ts
 * Writes both files under certs/manual/ (gitignored) - the private key is
 * NEVER printed to stdout, only the CSR (public information) is.
 */
const subject: ViafirmaCsrSubjectPN = {
  profileKind: "FE-PN",
  country: "CO",
  state: "Risaralda",
  locality: "Pereira",
  address: "MZ 1 CA 8 Ciudad Boquia Parque Industrial",
  identity: "1088348033",
  email: "alejandrovallejo10@outlook.com",
  givenName: "Alejandro",
  surname: "Vallejo Parra",
};

const { csrPem, privateKeyPem } = generateKeyPairAndCsr(subject);

const outDir = join(import.meta.dirname, "..", "certs", "manual");
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, "private-dian-clean.key"), privateKeyPem, "utf-8");
writeFileSync(join(outDir, "csr-dian-clean.csr"), csrPem, "utf-8");

console.log("Private key saved to certs/manual/private-dian-clean.key (not printed here)");
console.log("CSR saved to certs/manual/csr-dian-clean.csr - contents below (safe, public):\n");
console.log(csrPem);
