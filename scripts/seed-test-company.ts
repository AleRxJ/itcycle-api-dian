/**
 * Provisions a single test Company (+ DianConfiguration, NumberingResolution,
 * Certificate) in ITCycle's database, so POST /api/v1/dian/test-invoice has
 * something to load.
 *
 * Two modes:
 *
 * 1. Real DIAN Sandbox registration (default): reuses the exact same
 *    DIAN_TEST_* environment variable names as dian-kit's own integration
 *    test suite (dian-kit/packages/core/tests/integration/dian-sandbox.test.ts)
 *    — see docs/dian/sandbox-tests.md for the full list.
 *
 *      DIAN_TEST_NIT=... DIAN_TEST_NIT_DV=... ... pnpm db:seed:test-company
 *
 * 2. SIMULATE=true: no DIAN registration needed at all. Generates a
 *    self-signed test certificate (dian-kit's own generateTestP12) and
 *    obviously-fake registration numbers, clearly labeled as simulated. Only
 *    useful together with DIAN_SIMULATION_MODE=true on the server — see
 *    docs/dian/simulation.md. NOT a substitute for a real Sandbox test.
 *
 *      SIMULATE=true pnpm db:seed:test-company
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateTestP12, loadP12 } from "@dian-kit/core";
import type { Party } from "@dian-kit/sdk-node";

import { prisma } from "../src/infrastructure/prisma.js";
import { LocalFileCertificateSecretStore } from "../src/providers/certificates/LocalFileCertificateSecretStore.js";
import { env } from "../src/shared/env.js";

const SIMULATE = process.env.SIMULATE === "true";

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

type TestEnv = Record<(typeof REQUIRED_VARS)[number], string>;

function readRequiredEnv(): TestEnv {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. See docs/dian/sandbox-tests.md. ` +
        "Or set SIMULATE=true to seed a fully local demo company instead — see docs/dian/simulation.md.",
    );
  }
  return Object.fromEntries(REQUIRED_VARS.map((key) => [key, process.env[key] as string])) as TestEnv;
}

/**
 * Fabricates a self-signed certificate + obviously-fake DIAN registration
 * numbers for local simulation. None of this would pass real DIAN
 * validation — pair with DIAN_SIMULATION_MODE=true on the server.
 */
function buildSimulatedEnv(): TestEnv {
  const p12Password = "simulated";
  const p12Buffer = generateTestP12(p12Password);
  return {
    DIAN_TEST_NIT: "900000001",
    DIAN_TEST_NIT_DV: "1",
    DIAN_TEST_SOFTWARE_ID: "simulated-software-id",
    DIAN_TEST_SOFTWARE_PIN: "0000",
    DIAN_TEST_TECH_KEY: "simulated-technical-key",
    DIAN_TEST_AUTH_NUMBER: "00000000000",
    DIAN_TEST_PREFIX: "SIMU",
    DIAN_TEST_START_NUMBER: "1",
    DIAN_TEST_END_NUMBER: "999999",
    // Not a real file path — write it once so the rest of the script can
    // treat both modes identically.
    DIAN_TEST_P12_PATH: writeTempP12(p12Buffer),
    DIAN_TEST_P12_PASSWORD: p12Password,
  };
}

function writeTempP12(p12Buffer: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "itcycle-simulated-cert-"));
  const path = join(dir, "simulated.p12");
  writeFileSync(path, p12Buffer);
  return path;
}

async function main() {
  const testEnv = SIMULATE ? buildSimulatedEnv() : readRequiredEnv();

  const p12Buffer = readFileSync(testEnv.DIAN_TEST_P12_PATH);
  const certData = loadP12(p12Buffer, testEnv.DIAN_TEST_P12_PASSWORD);

  const supplierName = process.env.DIAN_TEST_SUPPLIER_NAME ?? (SIMULATE ? "Empresa Simulada SAS" : "Empresa Prueba SAS");
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

  const secretReference = SIMULATE ? `${testEnv.DIAN_TEST_NIT}-simulated` : `${testEnv.DIAN_TEST_NIT}-sandbox-test`;
  const secretStore = new LocalFileCertificateSecretStore(env.certificatesDir);
  await secretStore.save(secretReference, { p12: p12Buffer, password: testEnv.DIAN_TEST_P12_PASSWORD });

  await prisma.certificate.upsert({
    where: { id: secretReference },
    create: {
      id: secretReference,
      companyId: company.id,
      provider: SIMULATE ? "simulated" : "local-dev",
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

  console.log(`Seeded ${SIMULATE ? "SIMULATED" : "test"} company ${company.id} (NIT ${company.nit}-${company.dv}).`);
  if (SIMULATE) {
    console.log(
      "This is NOT a real DIAN registration — the certificate is self-signed and the NIT/software " +
        "IDs are fabricated. Set DIAN_SIMULATION_MODE=true when running the server so " +
        "test-invoice uses SimulatedDianProvider instead of trying to reach the real DIAN. " +
        "See docs/dian/simulation.md.",
    );
  }
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
