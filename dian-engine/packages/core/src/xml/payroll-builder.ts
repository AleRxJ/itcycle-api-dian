import { create } from "xmlbuilder2";
import type { XMLBuilder } from "xmlbuilder2/lib/interfaces.js";

import type { Address, PartyIdentification } from "../types/common.js";
import type { PayrollAmountLine, PayrollDocument } from "../types/payroll.js";
import { formatAmount, formatDate, formatTime } from "../utils/amount.js";
import {
  NS_PAYROLL_ADJUSTMENT,
  NS_PAYROLL_INDIVIDUAL,
  SCHEMA_LOCATION_PAYROLL_ADJUSTMENT,
  SCHEMA_LOCATION_PAYROLL_INDIVIDUAL,
} from "./namespaces.js";

/**
 * XML generation for Nómina Electrónica (DIAN Resolución 000013 de 2021,
 * Anexo Técnico de Nómina Electrónica) — a schema of DIAN's own (NOT UBL
 * 2.1, unlike builder.ts's Invoice/CreditNote/DebitNote), added alongside
 * the invoicing builder without changing anything in it.
 *
 * ⚠️ VERIFY BEFORE PRODUCTION USE (same caveat as security/cune.ts): the
 * element names/nesting/ordering below are a best-effort reconstruction of
 * the payroll Anexo Técnico's structure (Encabezado / Empleador /
 * Trabajador / Pago / Devengados / Deducciones), not a transcription of the
 * published XSD. Cross-check every tag name against DIAN's official
 * documentation before trusting a document built here to pass habilitación.
 * The digital-signature placement (a placeholder comment `signXml`
 * string-replaces, see security/signer.ts) IS reused unchanged and IS safe
 * to trust regardless of the surrounding tag names.
 */

const PLACEHOLDER_SIGNATURE = "FIRMA DIGITAL XAdES-BES AQUÍ";

function addIdentificationNode(parent: XMLBuilder, tagName: string, identification: PartyIdentification): void {
  const node = parent.ele(tagName);
  node.att("TipoDocumento", identification.type);
  if (identification.dv) node.att("DV", identification.dv);
  node.txt(identification.number);
}

function addAddressNode(parent: XMLBuilder, tagName: string, address: Address): void {
  const node = parent.ele(tagName);
  node.ele("Pais").txt(address.countryCode ?? "CO");
  node.ele("DepartamentoEstado").txt(address.departmentCode);
  node.ele("MunicipioCiudad").txt(address.cityCode);
  node.ele("Direccion").txt(address.street);
}

/** Groups a flat PayrollAmountLine[] by concept prefix (e.g. every "horas_extra_*" line together) so each DIAN container element gets all its own lines in one pass. */
function linesByFamily(lines: PayrollAmountLine[], family: string): PayrollAmountLine[] {
  return lines.filter((l) => l.concept === family || l.concept.startsWith(`${family}_`));
}

function sumAmount(lines: PayrollAmountLine[]): number {
  return lines.reduce((sum, l) => sum + l.amount, 0);
}

function addEarningsNode(parent: XMLBuilder, doc: PayrollDocument): void {
  const devengados = parent.ele("Devengados");
  const { lines } = doc.earnings;

  const basico = linesByFamily(lines, "basico");
  if (basico.length > 0) {
    const node = devengados.ele("Basico");
    node.ele("DiasTrabajados").txt(String(doc.period.workedDays));
    node.ele("SueldoTrabajado").txt(formatAmount(sumAmount(basico)));
  }

  const transporte = linesByFamily(lines, "transporte");
  if (transporte.length > 0) {
    devengados.ele("Transporte").ele("AuxilioTransporte").txt(formatAmount(sumAmount(transporte)));
  }

  const overtime = lines.filter((l) => l.concept.startsWith("horas_extra") || l.concept.startsWith("recargo"));
  if (overtime.length > 0) {
    const node = devengados.ele("HorasExtrasRecargos");
    for (const line of overtime) {
      const item = node.ele("Item");
      item.att("Concepto", line.concept);
      if (line.quantity !== undefined) item.ele("Cantidad").txt(String(line.quantity));
      if (line.percentage !== undefined) item.ele("Porcentaje").txt(String(line.percentage));
      item.ele("Pago").txt(formatAmount(line.amount));
    }
  }

  const vacaciones = linesByFamily(lines, "vacaciones");
  if (vacaciones.length > 0) {
    const node = devengados.ele("Vacaciones");
    for (const line of vacaciones) {
      if (line.quantity !== undefined) node.ele("Cantidad").txt(String(line.quantity));
      node.ele("Pago").txt(formatAmount(line.amount));
    }
  }

  const primas = linesByFamily(lines, "prima");
  if (primas.length > 0) {
    devengados.ele("Primas").ele("Pago").txt(formatAmount(sumAmount(primas)));
  }

  const cesantias = lines.find((l) => l.concept === "cesantias");
  const interesesCesantias = lines.find((l) => l.concept === "intereses_cesantias");
  if (cesantias || interesesCesantias) {
    const node = devengados.ele("Cesantias");
    if (cesantias) node.ele("Cesantias").txt(formatAmount(cesantias.amount));
    if (interesesCesantias) node.ele("InteresesCesantias").txt(formatAmount(interesesCesantias.amount));
  }

  const bonificaciones = linesByFamily(lines, "bonificacion");
  if (bonificaciones.length > 0) {
    devengados.ele("Bonificaciones").ele("Pago").txt(formatAmount(sumAmount(bonificaciones)));
  }

  const known = new Set(["basico", "transporte", "vacaciones", "prima", "cesantias", "intereses_cesantias", "bonificacion"]);
  const other = lines.filter(
    (l) => !known.has(l.concept) && !l.concept.startsWith("horas_extra") && !l.concept.startsWith("recargo"),
  );
  if (other.length > 0) {
    const node = devengados.ele("OtrosConceptos");
    for (const line of other) {
      const item = node.ele("Item");
      item.att("Concepto", line.description ?? line.concept);
      item.ele("Pago").txt(formatAmount(line.amount));
    }
  }

  devengados.ele("TotalDevengado").txt(formatAmount(doc.earnings.total));
}

function addDeductionsNode(parent: XMLBuilder, doc: PayrollDocument): void {
  const deducciones = parent.ele("Deducciones");
  const { lines } = doc.deductions;

  const salud = lines.find((l) => l.concept === "salud");
  if (salud) {
    const node = deducciones.ele("Salud");
    if (salud.percentage !== undefined) node.ele("Porcentaje").txt(String(salud.percentage));
    node.ele("Deduccion").txt(formatAmount(salud.amount));
  }

  const pension = lines.find((l) => l.concept === "pension");
  if (pension) {
    const node = deducciones.ele("FondoPension");
    if (pension.percentage !== undefined) node.ele("Porcentaje").txt(String(pension.percentage));
    node.ele("Deduccion").txt(formatAmount(pension.amount));
  }

  const solidarityFund = lines.find((l) => l.concept === "fondo_solidaridad");
  if (solidarityFund) {
    const node = deducciones.ele("FondoSP");
    if (solidarityFund.percentage !== undefined) node.ele("Porcentaje").txt(String(solidarityFund.percentage));
    node.ele("DeduccionSP").txt(formatAmount(solidarityFund.amount));
  }

  const withholding = lines.find((l) => l.concept === "retencion_fuente");
  if (withholding) {
    deducciones.ele("RetencionFuente").txt(formatAmount(withholding.amount));
  }

  const known = new Set(["salud", "pension", "fondo_solidaridad", "retencion_fuente"]);
  const other = lines.filter((l) => !known.has(l.concept));
  if (other.length > 0) {
    const node = deducciones.ele("OtrasDeducciones");
    for (const line of other) {
      const item = node.ele("Item");
      item.att("Concepto", line.description ?? line.concept);
      item.ele("Deduccion").txt(formatAmount(line.amount));
    }
  }

  deducciones.ele("TotalDeducciones").txt(formatAmount(doc.deductions.total));
}

/**
 * Builds a NominaIndividual XML document (DIAN xmlType "102"). Adjustment
 * documents ("103", NominaIndividualDeAjuste) share the same body via
 * {@link buildPayrollAdjustmentXml} - only the root element/namespace and a
 * leading `TipoNota`-style correction block differ.
 *
 * `cune`/`softwareSecurityCode` are pre-computed by the caller (dian-kit.ts's
 * processDocument, same two-argument shape buildInvoiceXml already takes)
 * rather than derived in here, so this function never needs to know how
 * either is calculated.
 */
export function buildPayrollXml(doc: PayrollDocument, cune: string, softwareSecurityCode: string): string {
  return buildPayrollDocumentXml(doc, false, cune, softwareSecurityCode);
}

/** Builds a NominaIndividualDeAjuste XML document (DIAN xmlType "103") - see {@link buildPayrollXml}. */
export function buildPayrollAdjustmentXml(doc: PayrollDocument, cune: string, softwareSecurityCode: string): string {
  return buildPayrollDocumentXml(doc, true, cune, softwareSecurityCode);
}

function buildPayrollDocumentXml(doc: PayrollDocument, isAdjustment: boolean, cune: string, softwareSecurityCode: string): string {
  const ns = isAdjustment ? NS_PAYROLL_ADJUSTMENT : NS_PAYROLL_INDIVIDUAL;
  const schemaLocation = isAdjustment ? SCHEMA_LOCATION_PAYROLL_ADJUSTMENT : SCHEMA_LOCATION_PAYROLL_INDIVIDUAL;
  const rootName = isAdjustment ? "NominaIndividualDeAjuste" : "NominaIndividual";

  const root = create({ version: "1.0", encoding: "UTF-8", standalone: false }).ele(ns, rootName);
  root.att("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance");
  root.att("xsi:schemaLocation", schemaLocation);

  // Digital-signature placeholder - signXml (security/signer.ts) string-replaces
  // this exact comment; reused unchanged from the invoicing builder's own
  // convention, see this module's own doc comment.
  root.com(PLACEHOLDER_SIGNATURE);

  const encabezado = root.ele("Encabezado");
  encabezado.ele("Version").txt("V1.0");
  encabezado.ele("Ambiente").txt(doc.environment);
  encabezado.ele("CUNE").txt(cune);
  encabezado.ele("SoftwareSecurityCode").txt(softwareSecurityCode);
  encabezado.ele("FechaGen").txt(formatDate(doc.issueDate));
  encabezado.ele("HoraGen").txt(formatTime(doc.issueTime));
  encabezado.ele("TipoXML").txt(isAdjustment ? "103" : "102");

  const secuencia = encabezado.ele("NumeroSecuenciaXML");
  secuencia.att("numero", "1");
  secuencia.ele("Consecutivo").txt(doc.id);

  if (isAdjustment) {
    if (!doc.adjustmentType || !doc.predecessorCune) {
      throw new Error(
        "[DIAN-KIT] adjustmentType y predecessorCune son obligatorios para una NominaIndividualDeAjuste.",
      );
    }
    const ajuste = encabezado.ele("TipoNota");
    ajuste.att("TipoNota", doc.adjustmentType);
    ajuste.ele("CuneDocumentoPredecesor").txt(doc.predecessorCune);
  }

  const periodo = encabezado.ele("PeriodoNomina");
  periodo.ele("FechaIngreso").txt(formatDate(doc.period.admissionDate));
  periodo.ele("FechaLiquidacionInicio").txt(formatDate(doc.period.settlementStartDate));
  periodo.ele("FechaLiquidacionFin").txt(formatDate(doc.period.settlementEndDate));
  periodo.ele("TiempoLaborado").txt(String(doc.period.workedDays));
  periodo.ele("FechaGeneracion").txt(formatDate(doc.issueDate));

  const empleador = root.ele("Empleador");
  empleador.ele("RazonSocial").txt(doc.employer.razonSocial);
  addIdentificationNode(empleador, "NIT", doc.employer.identification);
  addAddressNode(empleador, "Domicilio", doc.employer.address);

  const trabajador = root.ele("Trabajador");
  addIdentificationNode(trabajador, "Identificacion", doc.worker.identification);
  trabajador.ele("PrimerApellido").txt(doc.worker.surname);
  if (doc.worker.secondSurname) trabajador.ele("SegundoApellido").txt(doc.worker.secondSurname);
  trabajador.ele("PrimerNombre").txt(doc.worker.firstName);
  if (doc.worker.otherNames) trabajador.ele("OtrosNombres").txt(doc.worker.otherNames);
  trabajador.ele("TipoTrabajador").txt(doc.worker.workerType);
  trabajador.ele("SubTipoTrabajador").txt(doc.worker.subType);
  trabajador.ele("SalarioIntegral").txt(doc.worker.integralSalary ? "true" : "false");
  trabajador.ele("TipoContrato").txt(doc.worker.contractType);
  addAddressNode(trabajador, "LugarTrabajo", doc.worker.workplace);
  trabajador.ele("SalarioBase").txt(formatAmount(doc.worker.baseSalary));

  const pago = root.ele("Pago");
  pago.ele("FormaPago").txt(doc.payment.paymentForm);
  pago.ele("MetodoPago").txt(doc.payment.paymentMethod);
  if (doc.payment.bankName) pago.ele("BancoNombre").txt(doc.payment.bankName);
  if (doc.payment.accountType) pago.ele("TipoCuenta").txt(doc.payment.accountType);
  if (doc.payment.accountNumber) pago.ele("NumeroCuenta").txt(doc.payment.accountNumber);

  addEarningsNode(root, doc);
  addDeductionsNode(root, doc);

  const comprobante = root.ele("ComprobanteTotal");
  comprobante.ele("TotalDevengado").txt(formatAmount(doc.earnings.total));
  comprobante.ele("TotalDeducciones").txt(formatAmount(doc.deductions.total));
  comprobante.ele("ComprobanteTotal").txt(formatAmount(doc.netPay));

  return root.end({ prettyPrint: true, indent: "  " });
}
