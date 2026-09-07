import "dotenv/config";

import { ViafirmaApiClient } from "../src/providers/viafirma/ViafirmaApiClient.js";
import { env } from "../src/shared/env.js";

/**
 * Manual connectivity check against Viafirma's live Sandbox — NOT part of
 * `pnpm test` (real network + real Sandbox credentials, matches the manual
 * intent of scripts/create-api-key.ts / seed-test-company.ts). Run with:
 *   pnpm tsx scripts/smoke-test-viafirma.ts
 * Prints the profile codes Sandbox returns for this Consumer Key — per
 * §2.3.1 of the API doc these are environment-specific and must never be
 * hardcoded; this script exists to fetch/verify them, not to store them.
 */
async function main() {
  if (!env.viafirmaConsumerKey || !env.viafirmaConsumerSecret) {
    throw new Error("VIAFIRMA_CONSUMER_KEY / VIAFIRMA_CONSUMER_SECRET are not set in .env");
  }

  const client = new ViafirmaApiClient({
    baseUrl: env.viafirmaBaseUrl,
    downloadBaseUrl: env.viafirmaDownloadBaseUrl ?? "",
    consumerKey: env.viafirmaConsumerKey,
    consumerSecret: env.viafirmaConsumerSecret,
    ra: env.viafirmaRa,
  });

  console.log(`Calling GET /ra/available-profiles?codRa=${env.viafirmaRa} against ${env.viafirmaBaseUrl} ...`);
  const profiles = await client.getAvailableProfiles(env.viafirmaRa);
  console.log(`Got ${profiles.length} profile(s):`);
  for (const p of profiles) {
    console.log(`- ${p.title} (${p.type}) code=${p.code}`);
    console.log(`  terms: ${p.terms}`);
  }

  for (const profile of profiles) {
    console.log(`\nCalling GET /ra/profile/${profile.code}/form?required=true ...`);
    const fields = await client.getProfileForm(profile.code);
    console.log(`  ${fields.length} field(s): ${fields.map((f) => f.name).join(", ")}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
