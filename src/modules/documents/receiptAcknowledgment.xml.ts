/**
 * PROVISIONAL / SIMULATION-ONLY - NOT VERIFIED AGAINST DIAN'S REAL RADIAN
 * TECHNICAL ANNEX (Resolución 000012 de 2021). The exact <ApplicationResponse>
 * UBL element structure, DIAN's real ResponseCode catalogue per event type,
 * and the DIAN-specific extension content (software security code, etc.)
 * that a real submission would need are all UNKNOWN as of this writing - the
 * official annex PDF could not be parsed with the tooling available when
 * this was written. This builder produces a best-effort, schema-plausible
 * UBL 2.1 ApplicationResponse skeleton (DocumentResponse/Response/
 * DocumentReference/SenderParty/ReceiverParty are real UBL 2.1
 * ApplicationResponse elements per the OASIS spec) good enough to be signed
 * and to exercise the rest of the pipeline end-to-end in
 * DIAN_SIMULATION_MODE. It MUST NOT be reachable when DIAN_SIMULATION_MODE
 * is false - see receiptAcknowledgment.service.ts#assertSimulationOnly.
 *
 * Deliberately NOT routed through dian-kit's assembleDocument/buildXxxXml
 * pipeline: that pipeline's schema hard-requires `lines`/`taxTotals`/
 * `legalMonetaryTotal`/full `Party` shapes an ApplicationResponse simply
 * doesn't have (confirmed: dian-kit's four XML builders - buildInvoiceXml/
 * buildCreditNoteXml/buildDebitNoteXml/buildSupportDocumentXml - none fit).
 */

export interface ReceiptAcknowledgmentXmlInput {
  id: string;
  issueDateTime: Date;
  /** The ITCycle-registered company acting as the real-world BUYER - the
   *  genuine sender/signer of this document. NOT reversed, unlike
   *  SupportDocument's customer/supplier party mapping - see this file's
   *  own note below and receiptAcknowledgment.service.ts's doc comment. */
  senderParty: { nit: string; dv: string; name: string };
  /** The third-party supplier whose invoice is being acknowledged. */
  receiverParty: { identification: string; name: string };
  referencedCufe: string;
  referencedInvoiceId?: string;
  responseCode: string;
  description: string;
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const formatDate = (date: Date): string => date.toISOString().slice(0, 10);
const formatTime = (date: Date): string => date.toISOString().slice(11, 19);

/**
 * Builds an unsigned UBL 2.1 ApplicationResponse XML string, ready for
 * signXml() to embed a XAdES-EPES signature into the placeholder comment
 * (same "FIRMA DIGITAL XAdES-BES AQUÍ" convention dian-kit's own builders
 * use, so the placeholder-replacement logic in signXml() works unchanged).
 */
export function buildReceiptAcknowledgmentXmlStub(input: ReceiptAcknowledgmentXmlInput): string {
  const issueDate = formatDate(input.issueDateTime);
  const issueTime = formatTime(input.issueDateTime);
  const referencedInvoiceId = input.referencedInvoiceId ?? "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <!-- PROVISIONAL: DIAN-specific extension content (e.g. software
             security code) intentionally omitted - unknown pending the
             real RADIAN technical annex. See this file's module doc comment. -->
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent><!--FIRMA DIGITAL XAdES-BES AQUÍ--></ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>${escapeXml(input.id)}</cbc:ID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:ResponseDate>${issueDate}</cbc:ResponseDate>
  <cbc:ResponseTime>${issueTime}</cbc:ResponseTime>
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ResponseCode>${escapeXml(input.responseCode)}</cbc:ResponseCode>
      <cbc:Description>${escapeXml(input.description)}</cbc:Description>
    </cac:Response>
    <cac:DocumentReference>
      <cbc:ID>${escapeXml(referencedInvoiceId)}</cbc:ID>
      <cbc:UUID schemeName="CUFE-SHA384">${escapeXml(input.referencedCufe)}</cbc:UUID>
    </cac:DocumentReference>
  </cac:DocumentResponse>
  <cac:SenderParty>
    <cac:PartyTaxScheme>
      <cbc:RegistrationName>${escapeXml(input.senderParty.name)}</cbc:RegistrationName>
      <cbc:CompanyID>${escapeXml(input.senderParty.nit)}</cbc:CompanyID>
    </cac:PartyTaxScheme>
  </cac:SenderParty>
  <cac:ReceiverParty>
    <cac:PartyTaxScheme>
      <cbc:RegistrationName>${escapeXml(input.receiverParty.name)}</cbc:RegistrationName>
      <cbc:CompanyID>${escapeXml(input.receiverParty.identification)}</cbc:CompanyID>
    </cac:PartyTaxScheme>
  </cac:ReceiverParty>
</ApplicationResponse>`;
}
