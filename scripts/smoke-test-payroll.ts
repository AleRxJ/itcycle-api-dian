/**
 * One-off local smoke test for the Nómina Electrónica pipeline
 * (createPayrollDocument -> createPayrollAdjustment), run against the
 * pre-seeded "Empresa Simulada SAS" company (see seed-test-company.ts
 * SIMULATE=true) with DIAN_SIMULATION_MODE=true, so signing is REAL (a real
 * self-signed cert, real CUNE, real XML, real XAdES) but nothing is ever
 * sent to the real DIAN — SimulatedDianProvider fakes only send/getStatus.
 *
 * This exists purely to catch structural bugs (like the period-date
 * conversion bug already found and fixed in nomina.service.ts) before
 * spending a real DIAN sandbox attempt on a malformed payload. NOT a
 * substitute for a real habilitación run.
 *
 *   npx tsx scripts/smoke-test-payroll.ts
 */
import { prisma } from "../src/infrastructure/prisma.js";
import { createPayrollAdjustment, createPayrollDocument, getPayrollDocument } from "../src/modules/documents/nomina.service.js";

const SIMULATED_NIT = "901836726";
const SIMULATED_DV = "5";
const NE_PREFIX = "SINE";

function samplePayrollPayload() {
  const now = new Date();
  const admissionDate = new Date("2024-01-15T00:00:00.000Z");
  const settlementStartDate = new Date("2026-09-01T00:00:00.000Z");
  const settlementEndDate = new Date("2026-09-30T00:00:00.000Z");

  const earningLines = [
    { concept: "basico", amount: 1500000 },
    { concept: "transporte", amount: 140606 },
  ];
  const deductionLines = [
    { concept: "salud", percentage: 4, amount: 60000 },
    { concept: "pension", percentage: 4, amount: 60000 },
  ];
  const earningsTotal = earningLines.reduce((sum, l) => sum + l.amount, 0);
  const deductionsTotal = deductionLines.reduce((sum, l) => sum + l.amount, 0);

  return {
    issueDate: now.toISOString(),
    issueTime: now.toISOString(),
    worker: {
      identification: { number: "1000000001", type: "13" },
      firstName: "Ana",
      surname: "Gómez",
      workerType: "01",
      subType: "00",
      integralSalary: false,
      contractType: "1",
      workplace: {
        street: "Calle 100 # 10-20",
        cityCode: "11001",
        cityName: "11001",
        departmentCode: "11",
        departmentName: "11",
        countryCode: "CO",
        postalZone: "000000",
      },
      baseSalary: 1500000,
    },
    period: {
      admissionDate: admissionDate.toISOString(),
      settlementStartDate: settlementStartDate.toISOString(),
      settlementEndDate: settlementEndDate.toISOString(),
      periodicity: "5",
      workedDays: 30,
    },
    payment: { paymentForm: "1", paymentMethod: "10" },
    earnings: { lines: earningLines, total: earningsTotal },
    deductions: { lines: deductionLines, total: deductionsTotal },
    netPay: earningsTotal - deductionsTotal,
  };
}

async function main() {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: SIMULATED_NIT, dv: SIMULATED_DV } } });
  if (!company) {
    throw new Error(`Simulated company (NIT ${SIMULATED_NIT}-${SIMULATED_DV}) not found — run: SIMULATE=true pnpm db:seed:test-company`);
  }
  console.log(`Using company ${company.id} (${company.name})`);

  const certificate = await prisma.certificate.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } });
  if (!certificate) throw new Error("Simulated company has no certificate — re-run the seed script.");

  await prisma.numberingResolution.upsert({
    where: { companyId_prefix: { companyId: company.id, prefix: NE_PREFIX } },
    create: {
      companyId: company.id,
      documentType: "NE",
      prefix: NE_PREFIX,
      resolutionNumber: "00000000000",
      startNumber: 1,
      endNumber: 999999,
      currentNumber: 1,
      startDate: new Date(),
      endDate: certificate.expiresAt,
    },
    update: {},
  });
  console.log(`Ensured NE numbering resolution (prefix ${NE_PREFIX}) for company ${company.id}`);

  const internalReference = `smoke-payroll-${Date.now()}`;
  console.log(`\nCreating payroll document (internalReference=${internalReference})...`);
  const document = await createPayrollDocument({ companyId: company.id, internalReference, payroll: samplePayrollPayload() });
  console.log("Result:", {
    id: document.id,
    status: document.status,
    documentNumber: document.documentNumber,
    cune: document.cune,
    errorMessage: document.errorMessage,
  });

  if (document.status !== "ACCEPTED") {
    console.log("\nDocument did not reach ACCEPTED — stopping before the adjustment test.");
    return;
  }

  const reread = await getPayrollDocument(company.id, document.id);
  console.log("\nRe-fetched document status:", reread?.status, "cune:", reread?.cune);

  console.log("\nCreating a payroll adjustment (Reemplazar) against it...");
  const adjustment = await createPayrollAdjustment({
    companyId: company.id,
    internalReference: `${internalReference}-adj`,
    payrollDocumentId: document.id,
    adjustmentType: "1",
    payroll: samplePayrollPayload(),
  });
  console.log("Adjustment result:", {
    id: adjustment.id,
    status: adjustment.status,
    documentNumber: adjustment.documentNumber,
    cune: adjustment.cune,
    errorMessage: adjustment.errorMessage,
  });
}

main()
  .then(() => console.log("\nSmoke test finished."))
  .catch((error) => {
    console.error("\nSmoke test FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
