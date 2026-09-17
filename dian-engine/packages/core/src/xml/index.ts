/**
 * @module xml
 *
 * UBL 2.1 XML generation for DIAN electronic documents.
 * Provides builders for Invoice, CreditNote, and DebitNote XML,
 * along with namespace constants and schema locations.
 */
export {
  type BuildXmlResult,
  buildCreditNoteXml,
  buildDebitNoteXml,
  buildInvoiceXml,
  buildSupportDocumentXml,
} from "./builder.js";
export {
  NS,
  NS_PAYROLL_ADJUSTMENT,
  NS_PAYROLL_INDIVIDUAL,
  PROFILE_EXECUTION_ID,
  SCHEMA_LOCATION,
  SCHEMA_LOCATION_CREDIT_NOTE,
  SCHEMA_LOCATION_DEBIT_NOTE,
  SCHEMA_LOCATION_PAYROLL_ADJUSTMENT,
  SCHEMA_LOCATION_PAYROLL_INDIVIDUAL,
  UBL_VERSION,
} from "./namespaces.js";
// Nómina Electrónica - added alongside the UBL invoicing builders above,
// never replacing any of them. See payroll-builder.ts's own "verify before
// production use" caveat.
export { buildPayrollAdjustmentXml, buildPayrollXml } from "./payroll-builder.js";
