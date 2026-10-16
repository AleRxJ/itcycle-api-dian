import { describe, expect, it } from "vitest";

import type { PayrollDocument } from "../../src/types/payroll.js";
import { buildPayrollXml } from "../../src/xml/payroll-builder.js";

function createPayrollDocument(earningLines: PayrollDocument["earnings"]["lines"]): PayrollDocument {
  const total = earningLines.reduce((sum, l) => sum + l.amount, 0);
  return {
    xmlType: "102",
    environment: "2",
    id: "NIE1",
    issueDate: new Date("2026-10-31T12:00:00Z"),
    issueTime: new Date("2026-10-31T12:00:00Z"),
    employer: {
      razonSocial: "Tienda Prueba SAS",
      identification: { type: "31", number: "900123456", dv: "7" },
      address: { countryCode: "CO", departmentCode: "11", cityCode: "11001", street: "Calle 1" },
    },
    worker: {
      identification: { type: "13", number: "1020304050" },
      firstName: "Ana",
      surname: "Ruiz",
      workerType: "01",
      subType: "00",
      integralSalary: false,
      contractType: "1",
      workplace: { countryCode: "CO", departmentCode: "11", cityCode: "11001", street: "Calle 1" },
      baseSalary: 1423500,
    },
    period: {
      admissionDate: new Date("2026-01-01T00:00:00Z"),
      settlementStartDate: new Date("2026-10-01T00:00:00Z"),
      settlementEndDate: new Date("2026-10-31T00:00:00Z"),
      workedDays: 30,
    },
    payment: { paymentForm: "1", paymentMethod: "10" },
    earnings: { lines: earningLines, total },
    deductions: { lines: [], total: 0 },
    netPay: total,
    software: { id: "sw", pin: "1", providerNit: "900123456" },
    numbering: {
      authorizationNumber: "1",
      prefix: "NIE",
      startNumber: 1,
      endNumber: 100,
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-12-31T00:00:00Z"),
    },
  } as unknown as PayrollDocument;
}

describe("buildPayrollXml - comisiones", () => {
  it("emits <Comisiones><Comision> for commission lines, not OtrosConceptos", () => {
    const xml = buildPayrollXml(
      createPayrollDocument([
        { concept: "basico", amount: 1423500 },
        { concept: "comision", description: "Comisiones", amount: 85000 },
      ]),
      "cune",
      "ssc",
    );
    expect(xml).toMatch(/<Comisiones>\s*<Comision>85000\.00<\/Comision>\s*<\/Comisiones>/);
    expect(xml).not.toContain("OtrosConceptos");
  });

  it("places Comisiones after OtrosConceptos and before TotalDevengado", () => {
    const xml = buildPayrollXml(
      createPayrollDocument([
        { concept: "basico", amount: 1000000 },
        { concept: "otro", description: "Auxilio X", amount: 5000 },
        { concept: "comision", amount: 20000 },
        { concept: "comision", amount: 30000 },
      ]),
      "cune",
      "ssc",
    );
    const otros = xml.indexOf("<OtrosConceptos>");
    const comisiones = xml.indexOf("<Comisiones>");
    const total = xml.indexOf("<TotalDevengado>");
    expect(otros).toBeGreaterThan(-1);
    expect(comisiones).toBeGreaterThan(otros);
    expect(total).toBeGreaterThan(comisiones);
    expect(xml.match(/<Comision>/g)).toHaveLength(2);
  });

  it("emits no Comisiones node without commission lines", () => {
    const xml = buildPayrollXml(createPayrollDocument([{ concept: "basico", amount: 1000000 }]), "cune", "ssc");
    expect(xml).not.toContain("<Comisiones>");
  });
});
