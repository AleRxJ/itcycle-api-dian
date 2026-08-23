/**
 * Creates a production API key for a Company and prints the raw value
 * exactly once. Only the SHA-256 hash is ever persisted (see
 * src/shared/apiKeyAuth.ts) — if the printed key is lost, there is no way
 * to recover it; run this script again to issue a new one.
 *
 *   COMPANY_ID=<id> LABEL="Ohnix production" pnpm tsx scripts/create-api-key.ts
 */
import { generateApiKey } from "../src/shared/apiKeyAuth.js";
import { prisma } from "../src/infrastructure/prisma.js";

async function main() {
  const companyId = process.env.COMPANY_ID;
  const label = process.env.LABEL ?? "unlabeled";
  if (!companyId) {
    throw new Error("COMPANY_ID environment variable is required.");
  }

  await prisma.company.findUniqueOrThrow({ where: { id: companyId } });

  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  await prisma.apiKey.create({ data: { companyId, keyHash, keyPrefix, label } });

  console.log(`API key created for company ${companyId} (label: "${label}").`);
  console.log("");
  console.log(rawKey);
  console.log("");
  console.log(
    "This is the ONLY time this key is shown — it is not stored anywhere in plaintext. " +
      "Save it now (e.g. in Ohnix's own secret manager). If it's lost, run this script again to issue a new one.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
