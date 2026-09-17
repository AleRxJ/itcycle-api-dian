import type { Address, PartyIdentification, SoftwareInfo } from "./common.js";

/**
 * Colombian Nómina Electrónica (DIAN Resolución 000013 de 2021, Anexo
 * Técnico de Nómina Electrónica) — a COMPLETELY separate XML schema from
 * UBL 2.1 invoicing (own root elements, own field catalog), even though it
 * reuses the same SHA-384 hashing convention (CUNE instead of CUFE/CUDE),
 * the same XAdES-EPES signing mechanism, and the same DIAN SOAP transport
 * (WcfDianCustomerServices — see constants/dian-endpoints.ts).
 *
 * IMPORTANT — unlike the invoicing types elsewhere in this package (which
 * mirror the OASIS UBL 2.1 spec + years of production DIAN traffic through
 * this exact codebase), these payroll types were authored from general
 * knowledge of the Anexo Técnico, not by validating against the official
 * DIAN XSD or a successful habilitación run. Field names/nesting here are a
 * best-effort, internally-consistent model of the domain (empleador,
 * trabajador, período, devengados, deducciones) — treat every literal DIAN
 * catalog code (tipo de trabajador, tipo de contrato, etc.) as a
 * placeholder to double-check against DIAN's published tables before
 * relying on this for a real submission.
 */

/** DIAN "TipoTrabajador" catalog (Anexo Técnico, tabla 8.1) — trimmed to the values Ohnix's own payroll module produces. */
export const PayrollWorkerType = {
  DEPENDIENTE: "01",
  PENSIONADO: "04",
  APRENDIZ_SENA: "12",
} as const;
export type PayrollWorkerTypeValue = (typeof PayrollWorkerType)[keyof typeof PayrollWorkerType];

/** DIAN "SubTipoTrabajador" catalog. */
export const PayrollWorkerSubType = {
  NORMAL: "00",
  ALTO_RIESGO: "01",
} as const;
export type PayrollWorkerSubTypeValue = (typeof PayrollWorkerSubType)[keyof typeof PayrollWorkerSubType];

/** DIAN "TipoContrato" catalog. */
export const PayrollContractType = {
  INDEFINIDO: "1",
  FIJO: "2",
  OBRA_LABOR: "3",
  APRENDIZAJE: "4",
} as const;
export type PayrollContractTypeValue = (typeof PayrollContractType)[keyof typeof PayrollContractType];

/** DIAN "Periodo" (payroll periodicity) catalog. */
export const PayrollPeriodicity = {
  SEMANAL: "1",
  DECADAL: "2",
  CATORCENAL: "3",
  QUINCENAL: "4",
  MENSUAL: "5",
} as const;
export type PayrollPeriodicityValue = (typeof PayrollPeriodicity)[keyof typeof PayrollPeriodicity];

/**
 * The two "NominaIndividualDeAjuste" correction modes — analogous to a
 * credit/debit note's discrepancyResponse, but binary: replace the whole
 * document, or void it entirely. There is no partial-adjustment concept
 * (unlike invoicing's credit notes) — a payroll correction always
 * resupersedes the full original document.
 */
export const PayrollAdjustmentType = {
  /** "1" — Reemplazar: a corrected NominaIndividual replacing the original in full. */
  REEMPLAZAR: "1",
  /** "2" — Eliminar: voids the original document entirely (e.g. issued for the wrong worker/period). */
  ELIMINAR: "2",
} as const;
export type PayrollAdjustmentTypeValue = (typeof PayrollAdjustmentType)[keyof typeof PayrollAdjustmentType];

/** A minimal party identity for the employer side — narrower than invoicing's `Party` (no fiscal responsibilities/tax scheme, nómina doesn't carry those). */
export interface PayrollEmployer {
  razonSocial: string;
  identification: PartyIdentification;
  address: Address;
}

export interface PayrollWorker {
  identification: PartyIdentification;
  firstName: string;
  otherNames?: string;
  surname: string;
  secondSurname?: string;
  workerType: PayrollWorkerTypeValue;
  subType: PayrollWorkerSubTypeValue;
  /** Salario integral (CST art. 132) — changes nothing about the XML shape, but DIAN's schema still wants the flag. */
  integralSalary: boolean;
  contractType: PayrollContractTypeValue;
  workplace: Address;
  /** Full monthly-equivalent base salary, regardless of this document's own periodicity. */
  baseSalary: number;
}

export interface PayrollPeriod {
  admissionDate: Date;
  settlementStartDate: Date;
  settlementEndDate: Date;
  periodicity: PayrollPeriodicityValue;
  /** Days actually worked within [settlementStartDate, settlementEndDate], on the standard 30-day-month convention. */
  workedDays: number;
}

export interface PayrollPaymentInfo {
  /** "1" contado / "2" credito — mirrors invoicing's PaymentForm, DIAN reuses the same code. */
  paymentForm: string;
  /** DIAN payment-method code (10 efectivo, 42 consignación bancaria, 47 transferencia débito, etc — reuses invoicing's PaymentMethod catalog). */
  paymentMethod: string;
  bankName?: string;
  accountType?: string;
  accountNumber?: string;
}

/** One free-form devengado/deducción/aporte line - DIAN's schema has a dedicated element per concept (Basico, Transporte, HEDs, Cesantias, ...); this flat shape is translated into those concept-specific elements by the XML builder, keyed by `concept`. */
export interface PayrollAmountLine {
  /** Internal concept key the XML builder maps to a specific DIAN element - see xml/payroll-builder.ts's CONCEPT_ELEMENT table. */
  concept: string;
  /** Quantity (days/hours), when the concept is quantity-based (horas extra, vacaciones). */
  quantity?: number;
  /** Percentage/rate applied, when the concept carries one (horas extra surcharge %, aportes %). */
  percentage?: number;
  description?: string;
  amount: number;
}

export interface PayrollEarnings {
  lines: PayrollAmountLine[];
  total: number;
}

export interface PayrollDeductions {
  lines: PayrollAmountLine[];
  total: number;
}

/**
 * Complete payroll document ready for CUNE computation + XML generation —
 * the nómina counterpart to invoicing's `DianDocument`. `numbering`/
 * `software` are reused as-is from the invoicing types (same DIAN concepts:
 * a numbering resolution with its technicalKey, and the registered software
 * id/pin) even though nómina has its own, separate numbering resolution
 * range from invoicing's.
 */
export interface PayrollDocument {
  /** DIAN "TipoXML": "102" for NominaIndividual, "103" for NominaIndividualDeAjuste. */
  xmlType: "102" | "103";
  /** Only set when xmlType is "103" - which correction mode this adjustment applies. */
  adjustmentType?: PayrollAdjustmentTypeValue;
  /** Only set when xmlType is "103" - the CUNE of the NominaIndividual being replaced/voided. */
  predecessorCune?: string;
  environment: "1" | "2";
  /** Full document number including prefix, e.g. "NIE990000001". */
  id: string;
  issueDate: Date;
  issueTime: Date;
  employer: PayrollEmployer;
  worker: PayrollWorker;
  period: PayrollPeriod;
  payment: PayrollPaymentInfo;
  earnings: PayrollEarnings;
  deductions: PayrollDeductions;
  /** Devengado total - deducciones total (ComprobanteTotal / net pay). */
  netPay: number;
  software: SoftwareInfo;
  numbering: {
    authorizationNumber: string;
    prefix: string;
    startNumber: number;
    endNumber: number;
    startDate: Date;
    endDate: Date;
    technicalKey?: string;
  };
}
