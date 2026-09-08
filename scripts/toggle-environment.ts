import { prisma } from "../src/infrastructure/prisma.js";
import { setDianConfiguration } from "../src/modules/admin/admin.service.js";

const COMPANY_ID = "cmtbzaedh0000da2i0b52ib5x"; // Alejandro Vallejo Parra (alejandro.vallejo@utp.edu.co)
const TARGET_ENVIRONMENT = process.argv[2]; // "SANDBOX" or "PRODUCTION"

if (TARGET_ENVIRONMENT !== "SANDBOX" && TARGET_ENVIRONMENT !== "PRODUCTION") {
  throw new Error('Pass "SANDBOX" or "PRODUCTION" as the only argument.');
}

const config = await prisma.dianConfiguration.findUniqueOrThrow({ where: { companyId: COMPANY_ID } });
await setDianConfiguration({
  companyId: COMPANY_ID,
  environment: TARGET_ENVIRONMENT,
  softwareId: config.softwareId,
  softwarePin: config.softwarePin,
  technicalKey: config.technicalKey ?? undefined,
  supplierProfile: config.supplierProfile as Record<string, unknown>,
});
console.log(`Environment set to ${TARGET_ENVIRONMENT}.`);
process.exit(0);
