import { describe, expect, it } from "vitest";
import { buildInvoiceAttachedDocument, extractApplicationResponse } from "./attachedDocument.xml.js";

const SIGNED_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><cbc:ID>not-the-invoice</cbc:ID><cbc:IssueDate>1999-01-01</cbc:IssueDate></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
  <cbc:ProfileExecutionID>1</cbc:ProfileExecutionID>
  <cbc:ID>MARH1</cbc:ID>
  <cbc:UUID schemeID="1" schemeName="CUFE-SHA384">abc123cufe</cbc:UUID>
  <cbc:IssueDate>2026-10-29</cbc:IssueDate>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:RegistrationName>MARHOMA S.A.S</cbc:RegistrationName><cbc:CompanyID schemeID="5" schemeName="31">902117691</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyTaxScheme><cbc:RegistrationName>Cliente Uno</cbc:RegistrationName><cbc:CompanyID schemeName="13">1088348033</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingCustomerParty>
  <cbc:Note>contains ]]> on purpose</cbc:Note>
</Invoice>`;

const APPLICATION_RESPONSE = `<?xml version="1.0" encoding="utf-8"?><ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:IssueDate>2026-10-29</cbc:IssueDate><cbc:IssueTime>16:40:12-05:00</cbc:IssueTime></ApplicationResponse>`;

const RAW_SOAP = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><SendBillSyncResponse xmlns="http://wcf.dian.colombia"><SendBillSyncResult xmlns:b="http://schemas.datacontract.org/2004/07/DianResponse"><b:IsValid>true</b:IsValid><b:XmlBase64Bytes>${Buffer.from(APPLICATION_RESPONSE).toString("base64")}</b:XmlBase64Bytes></SendBillSyncResult></SendBillSyncResponse></s:Body></s:Envelope>`;

describe("extractApplicationResponse", () => {
  it("decodes DIAN's ApplicationResponse out of the SendBillSync answer", () => {
    expect(extractApplicationResponse(RAW_SOAP)).toBe(APPLICATION_RESPONSE);
  });

  it("returns null when there is none (e.g. a test-set send)", () => {
    expect(extractApplicationResponse("<s:Envelope><b:ZipKey>x</b:ZipKey></s:Envelope>")).toBeNull();
  });
});

describe("buildInvoiceAttachedDocument", () => {
  const { xml, invoiceNumber, cufe } = buildInvoiceAttachedDocument({ signedInvoiceXml: SIGNED_INVOICE, applicationResponseXml: APPLICATION_RESPONSE });

  it("takes the invoice's own ID/CUFE, not the ones inside UBLExtensions", () => {
    expect(invoiceNumber).toBe("MARH1");
    expect(cufe).toBe("abc123cufe");
    expect(xml).toContain("<cbc:ParentDocumentID>MARH1</cbc:ParentDocumentID>");
    expect(xml).toContain('<cbc:UUID schemeName="CUFE-SHA384">abc123cufe</cbc:UUID>');
  });

  it("copies sender and receiver PartyTaxScheme verbatim", () => {
    expect(xml).toMatch(/<cac:SenderParty>\s*<cac:PartyTaxScheme><cbc:RegistrationName>MARHOMA S.A.S/);
    expect(xml).toMatch(/<cac:ReceiverParty>\s*<cac:PartyTaxScheme><cbc:RegistrationName>Cliente Uno/);
  });

  it("embeds both documents and DIAN's validation moment", () => {
    expect(xml).toContain("<cbc:ValidationDate>2026-10-29</cbc:ValidationDate>");
    expect(xml).toContain("<cbc:ValidationTime>16:40:12-05:00</cbc:ValidationTime>");
    expect(xml).toContain("<cbc:ValidationResultCode>02</cbc:ValidationResultCode>");
    expect(xml).toContain("<cbc:DocumentType>Contenedor de Factura Electrónica</cbc:DocumentType>");
    // "]]>" inside an embedded document must not end its CDATA early.
    expect(xml).toContain("]]]]><![CDATA[>");
    expect((xml.match(/<!\[CDATA\[/g) || []).length).toBe(3);
  });
});
