import { describe, expect, it } from "vitest";

import {
  AddressSchema,
  InvoiceLineSchema,
  LegalMonetaryTotalSchema,
  PartyIdentificationSchema,
  TaxSubtotalSchema,
} from "../../src/schemas/common.schema.js";

describe("Zod Schemas", () => {
  describe("AddressSchema", () => {
    it("validates a complete address", () => {
      const result = AddressSchema.safeParse({
        street: "Calle 100 # 45-67",
        cityCode: "11001",
        cityName: "Bogotá, D.C.",
        departmentCode: "11",
        departmentName: "Bogotá",
      });
      expect(result.success).toBe(true);
    });

    it("sets default country to CO", () => {
      const result = AddressSchema.parse({
        street: "Calle 100 # 45-67",
        cityCode: "11001",
        cityName: "Bogotá, D.C.",
        departmentCode: "11",
        departmentName: "Bogotá",
      });
      expect(result.countryCode).toBe("CO");
      expect(result.countryName).toBe("Colombia");
    });

    it("rejects empty street", () => {
      const result = AddressSchema.safeParse({
        street: "",
        cityCode: "11001",
        cityName: "Bogotá",
        departmentCode: "11",
        departmentName: "Bogotá",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("PartyIdentificationSchema", () => {
    it("validates NIT with DV", () => {
      const result = PartyIdentificationSchema.safeParse({
        number: "900123456",
        type: "31",
        dv: "7",
      });
      expect(result.success).toBe(true);
    });

    it("validates cédula without DV", () => {
      const result = PartyIdentificationSchema.safeParse({
        number: "52123456",
        type: "13",
      });
      expect(result.success).toBe(true);
    });

    it("rejects invalid document type", () => {
      const result = PartyIdentificationSchema.safeParse({
        number: "12345",
        type: "99",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("TaxSubtotalSchema", () => {
    it("validates IVA subtotal", () => {
      const result = TaxSubtotalSchema.safeParse({
        taxableAmount: 500000,
        taxAmount: 95000,
        percent: 19,
        taxScheme: { code: "01", name: "IVA" },
      });
      expect(result.success).toBe(true);
    });

    it("rejects negative amounts", () => {
      const result = TaxSubtotalSchema.safeParse({
        taxableAmount: -100,
        taxAmount: 0,
        percent: 0,
        taxScheme: { code: "01" },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("InvoiceLineSchema", () => {
    it("validates a complete line item", () => {
      const result = InvoiceLineSchema.safeParse({
        id: "1",
        quantity: 2,
        description: "Corte de cabello",
        price: 25000,
        lineExtensionAmount: 50000,
        taxTotals: [
          {
            taxAmount: 9500,
            subtotals: [
              {
                taxableAmount: 50000,
                taxAmount: 9500,
                percent: 19,
                taxScheme: { code: "01", name: "IVA" },
              },
            ],
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("defaults unitCode to EA", () => {
      const result = InvoiceLineSchema.parse({
        id: "1",
        quantity: 1,
        description: "Test",
        price: 100,
        lineExtensionAmount: 100,
        taxTotals: [
          {
            taxAmount: 0,
            subtotals: [
              {
                taxableAmount: 100,
                taxAmount: 0,
                percent: 0,
                taxScheme: { code: "01" },
              },
            ],
          },
        ],
      });
      expect(result.unitCode).toBe("EA");
    });

    it("rejects zero quantity", () => {
      const result = InvoiceLineSchema.safeParse({
        id: "1",
        quantity: 0,
        description: "Test",
        price: 100,
        lineExtensionAmount: 0,
        taxTotals: [{ taxAmount: 0, subtotals: [{ taxableAmount: 0, taxAmount: 0, percent: 0, taxScheme: { code: "01" } }] }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("LegalMonetaryTotalSchema", () => {
    it("validates with defaults", () => {
      const result = LegalMonetaryTotalSchema.parse({
        lineExtensionAmount: 105000,
        taxExclusiveAmount: 105000,
        taxInclusiveAmount: 124950,
        payableAmount: 124950,
      });
      expect(result.allowanceTotalAmount).toBe(0);
      expect(result.chargeTotalAmount).toBe(0);
      expect(result.prepaidAmount).toBe(0);
    });
  });
});

describe("TaxSubtotalSchema — per-unit taxes", () => {
  it("accepts INC bolsas with a per-unit amount and base unit, without percent", () => {
    expect(TaxSubtotalSchema.safeParse({ taxableAmount: 0, taxAmount: 132, perUnitAmount: 66, baseUnitMeasure: { quantity: 1, unitCode: "94" }, taxScheme: { code: "22" } }).success).toBe(true);
  });
  it("rejects a subtotal with neither a percent nor a per-unit amount", () => {
    expect(TaxSubtotalSchema.safeParse({ taxableAmount: 0, taxAmount: 132, taxScheme: { code: "22" } }).success).toBe(false);
  });
});

describe("InvoiceLineSchema — free lines", () => {
  const line = { id: "1", quantity: 2, description: "Bolsa", lineExtensionAmount: 0, taxTotals: [{ taxAmount: 132, subtotals: [{ taxableAmount: 0, taxAmount: 132, perUnitAmount: 66, baseUnitMeasure: { quantity: 1, unitCode: "94" }, taxScheme: { code: "22" } }] }] };
  it("accepts price 0 with a referencePrice", () => {
    expect(InvoiceLineSchema.safeParse({ ...line, price: 0, referencePrice: 50 }).success).toBe(true);
  });
  it("rejects price 0 without a referencePrice", () => {
    expect(InvoiceLineSchema.safeParse({ ...line, price: 0 }).success).toBe(false);
  });
});
