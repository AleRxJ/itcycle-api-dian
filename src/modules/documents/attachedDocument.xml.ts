/**
 * DIAN "AttachedDocument" - the container a facturador electrónico must hand
 * the buyer (adquiriente) instead of a bare invoice XML: the signed invoice
 * plus DIAN's ApplicationResponse (its validation result), wrapped in one
 * UBL 2.1 AttachedDocument (Anexo técnico de factura electrónica, "Documentos
 * adjuntos"). Buyers' systems import this file and send their RADIAN events
 * (acuse de recibo...) off it, so a bare invoice XML can be refused there.
 *
 * Built purely from what we already store: the signed XML as it went to DIAN
 * (xmlStore) and DIAN's raw SendBillSync SOAP answer (rawResponseStore), whose
 * <XmlBase64Bytes> carries the ApplicationResponse. Sender/receiver parties
 * are copied verbatim from the invoice's own PartyTaxScheme blocks so they
 * can never disagree with the signed document.
 *
 * Not signed: DIAN never receives this file (it travels buyer-side only).
 */

const firstElement = (xml: string, qualifiedName: string): string | null => {
  const escaped = qualifiedName.replace(":", "\\:");
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?</${escaped}>`).exec(xml);
  return match ? match[0] : null;
};

const firstText = (xml: string, qualifiedName: string): string | null => {
  const element = firstElement(xml, qualifiedName);
  if (!element) return null;
  const inner = element.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "");
  return inner.trim();
};

// Everything after the UBL extensions block - the DIAN extension and the
// signature carry their own IDs/dates that must not be mistaken for the
// invoice's own cbc:ID / cbc:IssueDate.
const documentBody = (xml: string): string => {
  const end = xml.indexOf("</ext:UBLExtensions>");
  return end >= 0 ? xml.slice(end) : xml;
};

// A CDATA section can't contain "]]>" - split it across two sections.
const cdata = (content: string): string => `<![CDATA[${content.split("]]>").join("]]]]><![CDATA[>")}]]>`;

/** DIAN's ApplicationResponse, out of the raw SendBillSync SOAP response (null if absent). */
export function extractApplicationResponse(rawDianResponse: string): string | null {
  const base64 = firstText(rawDianResponse, "b:XmlBase64Bytes")
    ?? /<(?:[\w-]+:)?XmlBase64Bytes>([\s\S]*?)<\/(?:[\w-]+:)?XmlBase64Bytes>/.exec(rawDianResponse)?.[1]?.trim()
    ?? null;
  if (!base64) return null;
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  return decoded.includes("ApplicationResponse") ? decoded : null;
}

export interface AttachedDocumentResult {
  xml: string;
  invoiceNumber: string;
  cufe: string;
  issueDate: string;
}

export function buildInvoiceAttachedDocument(params: { signedInvoiceXml: string; applicationResponseXml: string }): AttachedDocumentResult {
  const { signedInvoiceXml, applicationResponseXml } = params;
  const body = documentBody(signedInvoiceXml);

  const invoiceNumber = firstText(body, "cbc:ID");
  const cufe = firstText(body, "cbc:UUID");
  const issueDate = firstText(body, "cbc:IssueDate");
  const profileExecutionId = firstText(body, "cbc:ProfileExecutionID") ?? "1";
  const supplierParty = firstElement(body, "cac:AccountingSupplierParty");
  const customerParty = firstElement(body, "cac:AccountingCustomerParty");
  const senderTaxScheme = supplierParty ? firstElement(supplierParty, "cac:PartyTaxScheme") : null;
  const receiverTaxScheme = customerParty ? firstElement(customerParty, "cac:PartyTaxScheme") : null;
  if (!invoiceNumber || !cufe || !issueDate || !senderTaxScheme || !receiverTaxScheme) {
    throw new Error("Signed invoice XML is missing ID/UUID/IssueDate or a PartyTaxScheme - cannot build its AttachedDocument");
  }

  const responseBody = documentBody(applicationResponseXml);
  const validationDate = firstText(responseBody, "cbc:IssueDate") ?? issueDate;
  const validationTime = firstText(responseBody, "cbc:IssueTime") ?? "00:00:00-05:00";

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AttachedDocument xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ccts="urn:un:unece:uncefact:data:specification:CoreComponentTypeSchemaModule:2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#">
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>Documentos adjuntos</cbc:CustomizationID>
  <cbc:ProfileID>Factura Electrónica de Venta</cbc:ProfileID>
  <cbc:ProfileExecutionID>${profileExecutionId}</cbc:ProfileExecutionID>
  <cbc:ID>${invoiceNumber}</cbc:ID>
  <cbc:IssueDate>${validationDate}</cbc:IssueDate>
  <cbc:IssueTime>${validationTime}</cbc:IssueTime>
  <cbc:DocumentType>Contenedor de Factura Electrónica</cbc:DocumentType>
  <cbc:ParentDocumentID>${invoiceNumber}</cbc:ParentDocumentID>
  <cac:SenderParty>
    ${senderTaxScheme}
  </cac:SenderParty>
  <cac:ReceiverParty>
    ${receiverTaxScheme}
  </cac:ReceiverParty>
  <cac:Attachment>
    <cac:ExternalReference>
      <cbc:MimeCode>text/xml</cbc:MimeCode>
      <cbc:EncodingCode>UTF-8</cbc:EncodingCode>
      <cbc:Description>${cdata(signedInvoiceXml)}</cbc:Description>
    </cac:ExternalReference>
  </cac:Attachment>
  <cac:ParentDocumentLineReference>
    <cbc:LineID>1</cbc:LineID>
    <cac:DocumentReference>
      <cbc:ID>${invoiceNumber}</cbc:ID>
      <cbc:UUID schemeName="CUFE-SHA384">${cufe}</cbc:UUID>
      <cbc:IssueDate>${issueDate}</cbc:IssueDate>
      <cbc:DocumentType>ApplicationResponse</cbc:DocumentType>
      <cac:Attachment>
        <cac:ExternalReference>
          <cbc:MimeCode>text/xml</cbc:MimeCode>
          <cbc:EncodingCode>UTF-8</cbc:EncodingCode>
          <cbc:Description>${cdata(applicationResponseXml)}</cbc:Description>
        </cac:ExternalReference>
      </cac:Attachment>
      <cac:ResultOfVerification>
        <cbc:ValidatorID>Unidad Especial Dirección de Impuestos y Aduanas Nacionales</cbc:ValidatorID>
        <cbc:ValidationResultCode>02</cbc:ValidationResultCode>
        <cbc:ValidationDate>${validationDate}</cbc:ValidationDate>
        <cbc:ValidationTime>${validationTime}</cbc:ValidationTime>
      </cac:ResultOfVerification>
    </cac:DocumentReference>
  </cac:ParentDocumentLineReference>
</AttachedDocument>`;

  return { xml, invoiceNumber, cufe, issueDate };
}
