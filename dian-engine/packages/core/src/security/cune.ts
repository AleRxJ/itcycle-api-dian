import type { PayrollDocument } from "../types/payroll.js";
import { formatDate, formatTime, truncateDecimals } from "../utils/amount.js";
import { sha384 } from "./cufe.js";

/**
 * CUNE (Código Único de Nómina Electrónica) generation — DIAN's Anexo
 * Técnico de Nómina Electrónica (Resolución 000013 de 2021) mandates the
 * same SHA-384 hashing convention as CUFE/CUDE (see security/cufe.ts), over
 * a DIFFERENT, shorter field concatenation specific to payroll documents.
 *
 * ⚠️ VERIFY BEFORE PRODUCTION USE: unlike `cufe.ts` (validated against years
 * of real DIAN invoicing traffic through this exact codebase), this
 * concatenation was authored from general knowledge of the payroll Anexo
 * Técnico, not from the published XSD/technical annex itself. The field
 * SET and ORDER below must be cross-checked against DIAN's official
 * documentation (or, failing that, against a document DIAN's own
 * habilitación sandbox accepts) before any real CUNE computed here is
 * trusted. A wrong CUNE fails safe: DIAN's habilitación will simply reject
 * the document (never a silent acceptance of bad data), so this is a
 * "won't validate yet" risk, not a data-integrity one.
 */

/**
 * The fields DIAN's payroll Anexo Técnico concatenates (no separator, same
 * as CUFE/CUDE) before SHA-384 hashing:
 *
 * `NumNI + FechaGeneracion + HoraGeneracion + ValorDevengadoTotal +
 *  ValorDeduccionTotal + NitEmpleador + NumeroDocumentoTrabajador +
 *  TipoAmbiente + ClaveTecnica`
 */
export interface CuneInput {
  /** Document number (NumNI) - e.g. "NIE990000001" */
  numNI: string;
  /** Generation date, YYYY-MM-DD (FechaGeneracion) */
  fechaGeneracion: string;
  /** Generation time, HH:MM:SS-05:00 (HoraGeneracion) */
  horaGeneracion: string;
  /** Total devengado, truncated to 2 decimals (ValorDevengadoTotal) */
  valorDevengadoTotal: string;
  /** Total deducciones, truncated to 2 decimals (ValorDeduccionTotal) */
  valorDeduccionTotal: string;
  /** Employer NIT, no DV (NitEmpleador) */
  nitEmpleador: string;
  /** Worker's identification number (NumeroDocumentoTrabajador) */
  numeroDocumentoTrabajador: string;
  /** Environment: "1" production / "2" sandbox (TipoAmbiente) */
  tipoAmbiente: string;
  /** Technical key from the payroll numbering resolution (ClaveTecnica) - same concept as invoicing's technicalKey, just a distinct resolution. */
  claveTecnica: string;
}

export function concatenateCuneFields(input: CuneInput): string {
  return [
    input.numNI,
    input.fechaGeneracion,
    input.horaGeneracion,
    input.valorDevengadoTotal,
    input.valorDeduccionTotal,
    input.nitEmpleador,
    input.numeroDocumentoTrabajador,
    input.tipoAmbiente,
    input.claveTecnica,
  ].join("");
}

export function buildCuneInput(doc: PayrollDocument): CuneInput {
  if (!doc.numbering.technicalKey) {
    throw new Error(
      "[DIAN-KIT] La clave técnica (technicalKey) de la resolución de numeración de nómina electrónica es obligatoria para calcular el CUNE.",
    );
  }
  return {
    numNI: doc.id,
    fechaGeneracion: formatDate(doc.issueDate),
    horaGeneracion: formatTime(doc.issueTime),
    valorDevengadoTotal: truncateDecimals(doc.earnings.total, 2),
    valorDeduccionTotal: truncateDecimals(doc.deductions.total, 2),
    nitEmpleador: doc.employer.identification.number,
    numeroDocumentoTrabajador: doc.worker.identification.number,
    tipoAmbiente: doc.environment,
    claveTecnica: doc.numbering.technicalKey,
  };
}

/**
 * Generates the CUNE for a payroll document — the nómina counterpart to
 * {@link generateCufe} in `cufe.ts`. See this module's own doc comment for
 * why the field set differs from CUFE/CUDE and what must be verified before
 * production use.
 */
export function generateCune(doc: PayrollDocument): string {
  const input = buildCuneInput(doc);
  const raw = concatenateCuneFields(input);
  return sha384(raw);
}
