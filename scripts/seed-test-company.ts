/**
 * Provisions a single test Company (+ DianConfiguration, NumberingResolution,
 * Certificate) in ITCycle's database from a DIAN sandbox (habilitacion)
 * registration, so POST /api/v1/dian/test-invoice has something to load.
 *
 * Reuses the exact same DIAN_TEST_* environment variable names as
 * dian-kit's own integration test suite
 * (dian-kit/packages/core/tests/integration/dian-sandbox.test.ts) — see
 * docs/dian/sandbox-tests.md for the full list.
 *
 * Usage:
 *   DIAN_TEST_NIT=... DIAN_TEST_NIT_DV=... ... pnpm db:seed:test-company
 */
import { readFileSync } from "node:fs";

import { loadP12 } from "@dian-kit/core";
import type { Party } from "@dian-kit/sdk-node";

import { prisma } from "../src/infrastructure/prisma.js";
import { LocalFileCertificateSecretStore } from "../src/providers/certificates/LocalFileCertificateSecretStore.js";
import { env } from "../src/shared/env.js";

const REQUIRED_VARS = [
  "DIAN_TEST_NIT",
  "DIAN_TEST_NIT_DV",
  "DIAN_TEST_SOFTWARE_ID",
  "DIAN_TEST_SOFTWARE_PIN",
  "DIAN_TEST_TECH_KEY",
  "DIAN_TEST_AUTH_NUMBER",
  "DIAN_TEST_PREFIX",
  "DIAN_TEST_START_NUMBER",
  "DIAN_TEST_END_NUMBER",
  "DIAN_TEST_P12_PATH",
  "DIAN_TEST_P12_PASSWORD",
] as const;

function readRequiredEnv(): Record<(typeof REQUIRED_VARS)[number], string> {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. See docs/dian/sandbox-tests.md.`,
    );
  }
  return Object.fromEntries(REQUIRED_VARS.map((key) => [key, process.env[key] as string])) as Record<
    (typeof REQUIRED_VARS)[number],
    string
  >;
}

async function main() {
  const testEnv = readRequiredEnv();

  const p12Buffer = readFileSync(testEnv.DIAN_TEST_P12_PATH);
  const certData = loadP12(p12Buffer, testEnv.DIAN_TEST_P12_PASSWORD);

  const supplierName = process.env.DIAN_TEST_SUPPLIER_NAME ?? "Empresa Prueba SAS";
  const supplierEmail = process.env.DIAN_TEST_SUPPLIER_EMAIL ?? "test@example.com";
  const supplierAddress = {
    street: "Calle 100 # 10-20",
    cityCode: "11001",
    cityName: "Bogota",
    departmentCode: "11",
    departmentName: "Bogota D.C.",
    countryCode: "CO",
    countryName: "Colombia",
    postalZone: "110111",
  };

  const supplierProfile: Party = {
    name: supplierName,
    identification: { number: testEnv.DIAN_TEST_NIT, type: "31", dv: testEnv.DIAN_TEST_NIT_DV },
    personType: "1",
    fiscalResponsibilities: ["O-13"],
    taxInfo: {
      registrationName: supplierName,
      companyId: { number: testEnv.DIAN_TEST_NIT, type: "31", dv: testEnv.DIAN_TEST_NIT_DV },
      taxLevelCode: "O-13",
      taxScheme: { code: "01" },
      address: supplierAddress,
    },
    address: supplierAddress,
    email: supplierEmail,
  };

  const company = await prisma.company.upsert({
    where: { nit_dv: { nit: testEnv.DIAN_TEST_NIT, dv: testEnv.DIAN_TEST_NIT_DV } },
    create: {
      name: supplierName,
      nit: testEnv.DIAN_TEST_NIT,
      dv: testEnv.DIAN_TEST_NIT_DV,
      personType: "1",
    },
    update: { name: supplierName },
  });

  await prisma.dianConfiguration.upsert({
    where: { companyId: company.id },
    create: {
      companyId: company.id,
      environment: "SANDBOX",
      softwareId: testEnv.DIAN_TEST_SOFTWARE_ID,
      softwarePin: testEnv.DIAN_TEST_SOFTWARE_PIN,
      technicalKey: testEnv.DIAN_TEST_TECH_KEY,
      supplierProfile: supplierProfile as object,
    },
    update: {
      softwareId: testEnv.DIAN_TEST_SOFTWARE_ID,
      softwarePin: testEnv.DIAN_TEST_SOFTWARE_PIN,
      technicalKey: testEnv.DIAN_TEST_TECH_KEY,
      supplierProfile: supplierProfile as object,
    },
  });

  await prisma.numberingResolution.upsert({
    where: { companyId_prefix: { companyId: company.id, prefix: testEnv.DIAN_TEST_PREFIX } },
    create: {
      companyId: company.id,
      prefix: testEnv.DIAN_TEST_PREFIX,
      resolutionNumber: testEnv.DIAN_TEST_AUTH_NUMBER,
      startNumber: Number(testEnv.DIAN_TEST_START_NUMBER),
      endNumber: Number(testEnv.DIAN_TEST_END_NUMBER),
      currentNumber: Number(testEnv.DIAN_TEST_START_NUMBER),
      startDate: new Date(),
      endDate: new Date(certData.notAfter),
    },
    update: {
      resolutionNumber: testEnv.DIAN_TEST_AUTH_NUMBER,
      startNumber: Number(testEnv.DIAN_TEST_START_NUMBER),
      endNumber: Number(testEnv.DIAN_TEST_END_NUMBER),
    },
  });

  const secretReference = `${testEnv.DIAN_TEST_NIT}-sandbox-test`;
  const secretStore = new LocalFileCertificateSecretStore(env.certificatesDir);
  await secretStore.save(secretReference, { p12: p12Buffer, password: testEnv.DIAN_TEST_P12_PASSWORD });

  await prisma.certificate.upsert({
    where: { id: secretReference },
    create: {
      id: secretReference,
      companyId: company.id,
      provider: "local-dev",
      certificateIdentifier: certData.serialNumber,
      secretReference,
      expiresAt: certData.notAfter,
    },
    update: {
      certificateIdentifier: certData.serialNumber,
      expiresAt: certData.notAfter,
      status: "ACTIVE",
    },
  });

  console.log(`Seeded test company ${company.id} (NIT ${company.nit}-${company.dv}).`);
  console.log("Try it:");
  console.log(
    `curl -X POST http://localhost:${env.port}/api/v1/dian/test-invoice ` +
      `-H "x-api-key: $DEV_API_KEY" -H "Content-Type: application/json" ` +
      `-d '{"companyId":"${company.id}","internalReference":"test-1","invoice":{...},"send":{"method":"SendTestSetAsync","testSetId":"${testEnv.DIAN_TEST_SET_ID ?? process.env.DIAN_TEST_SET_ID ?? ""}"}}'`,
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
