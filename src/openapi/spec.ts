/**
 * Hand-authored, static OpenAPI 3.0.3 document for the CUSTOMER-FACING
 * document API — the endpoints an external company's own POS/ERP/SaaS calls
 * directly with its own `x-api-key` to issue DIAN electronic documents
 * (invoices, credit notes, debit notes, support documents, and — Phase 1/
 * simulation only — RADIAN receipt acknowledgments).
 *
 * This file is a plain data object, not a live schema-validation
 * integration: it is served as-is by `GET /api/v1/openapi.json` (see
 * src/modules/openapi/openapi.route.ts) and never touches request
 * validation, which stays entirely on the Zod schemas in
 * src/modules/documents/documents.schemas.ts. It intentionally does NOT
 * document the /api/v1/admin/* (tenant provisioning) or /api/v1/dian/*
 * (dev-only test-invoice) routes — those are Ohnix-internal, never called by
 * a customer.
 *
 * Field shapes/descriptions for `invoice`/`document` bodies are transcribed
 * from dian-engine/packages/sdk-node/src/types.ts and
 * dian-engine/packages/core/src/types/common.ts (the real, richly-documented
 * TypeScript interfaces) — NOT from the permissive
 * `DocumentBodySchema = z.record(z.string(), z.unknown())` placeholder in
 * documents.schemas.ts, which exists only because dian-kit does its own
 * structural validation downstream.
 */

const PARTY_IDENTIFICATION_TYPES = ["11", "12", "13", "21", "22", "31", "41", "42", "47", "48", "50", "91"] as const;

const Address = {
  type: "object",
  description:
    "Represents a Colombian postal address used in party and tax registration data. City and department codes follow the DANE (national statistics department) codification.",
  properties: {
    street: { type: "string", description: 'Street address line (e.g., "Calle 100 #45-10")' },
    cityCode: { type: "string", description: 'DANE municipality code (e.g., "11001" for Bogota)' },
    cityName: { type: "string", description: 'Municipality name (e.g., "Bogota, D.C.")' },
    departmentCode: { type: "string", description: 'DANE department code (e.g., "11" for Bogota)' },
    departmentName: { type: "string", description: 'Department name (e.g., "Bogota")' },
    countryCode: { type: "string", description: 'ISO 3166-1 alpha-2 country code, defaults to "CO"' },
    countryName: { type: "string", description: 'Country name, defaults to "Colombia"' },
    postalZone: { type: "string", description: "Postal zone code, if applicable" },
  },
  required: ["street", "cityCode", "cityName", "departmentCode", "departmentName"],
};

const PartyIdentification = {
  type: "object",
  description:
    "Identification data for a party (supplier or customer) in a DIAN electronic document. Combines the document number with its type and optional verification digit.",
  properties: {
    number: { type: "string", description: 'Identification document number (e.g., NIT "900123456", CC "1234567890")' },
    type: {
      type: "string",
      enum: [...PARTY_IDENTIFICATION_TYPES],
      description:
        'Type of identification document as per DIAN codification: "11" Registro Civil, "12" Tarjeta de Identidad, "13" Cedula de Ciudadania, "21" Tarjeta de Extranjeria, "22" Cedula de Extranjeria, "31" NIT, "41" Pasaporte, "42" Documento Extranjero, "47" Permiso Especial de Permanencia (PEP), "48" Permiso por Proteccion Temporal (PPT), "50" NIT de otro pais, "91" NUIP.',
    },
    dv: { type: "string", description: "Verification digit (digito de verificacion), required only for NIT (type \"31\")" },
  },
  required: ["number", "type"],
};

const TaxScheme = {
  type: "object",
  description: "Tax scheme reference identifying a specific Colombian tax type. Used within tax subtotals and party tax information.",
  properties: {
    code: {
      type: "string",
      enum: ["01", "02", "03", "04", "05", "06", "07", "08", "20", "21", "22", "23", "24", "25", "26", "30", "32", "33", "34", "35", "36", "ZZ"],
      description:
        'DIAN tax code, e.g. "01" IVA, "02" IC, "03" ICA, "04" INC, "05" ReteIVA, "06" ReteRenta, "07" ReteICA, "ZZ" No Aplica (see dian-engine/packages/core/src/constants/tax-codes.ts for the full list).',
    },
    name: { type: "string", description: "Human-readable tax name; auto-resolved from TaxCodeName if omitted" },
  },
  required: ["code"],
};

const PartyTaxInfo = {
  type: "object",
  description: "Tax registration information for a party as required by DIAN. Populates the PartyTaxScheme UBL element with fiscal obligations and tax regime data.",
  properties: {
    registrationName: { type: "string", description: "Legal registration name as registered with DIAN (Razon Social or full name)" },
    companyId: { ...ref("PartyIdentification"), description: "Company identification matching the party's identification" },
    taxLevelCode: {
      type: "string",
      description: 'Fiscal responsibility code (e.g., "O-13" for Gran Contribuyente, "R-99-PN" for N/A)',
    },
    taxScheme: { ...ref("TaxScheme"), description: "Primary tax scheme the party is registered under" },
    address: { ...ref("Address"), description: "Tax registration address, if different from the party's physical address" },
  },
  required: ["registrationName", "companyId", "taxLevelCode", "taxScheme"],
};

const PersonInfo = {
  type: "object",
  description: "Individual person identification for natural persons (personType \"2\"). Required by DIAN when the party is a natural person (FAK61 rule).",
  properties: {
    firstName: { type: "string", description: "First name (primer nombre)" },
    familyName: { type: "string", description: "Family name / last name (primer apellido)" },
  },
  required: ["firstName", "familyName"],
};

const CorporateRegistration = {
  type: "object",
  description: "Corporate registration scheme for the supplier's PartyLegalEntity. The prefix must match the DIAN numbering authorization prefix. Required to avoid FAB10a rejection.",
  properties: {
    prefix: { type: "string", description: 'Invoice prefix matching the numbering authorization (e.g., "SETP")' },
    name: { type: "string", description: "Commercial registration number (matricula mercantil), optional" },
  },
  required: ["prefix"],
};

const Party = {
  type: "object",
  description:
    "Represents a party (supplier or customer) in a DIAN electronic document. Contains all identification, tax, address, and contact information required for AccountingSupplierParty and AccountingCustomerParty UBL elements.",
  properties: {
    name: { type: "string", description: "Legal or commercial name of the party" },
    identification: { ...ref("PartyIdentification"), description: "Tax identification number and document type" },
    personType: {
      type: "string",
      enum: ["1", "2"],
      description: 'Person type: "1" for legal entity, "2" for natural person',
    },
    fiscalResponsibilities: {
      type: "array",
      items: { type: "string" },
      description: "List of DIAN fiscal responsibility codes assigned to the party",
    },
    taxInfo: { ...ref("PartyTaxInfo"), description: "Detailed tax registration information for PartyTaxScheme" },
    address: { ...ref("Address"), description: "Physical location address of the party" },
    email: { type: "string", format: "email", description: "Contact email address for electronic notifications" },
    phone: { type: "string", description: "Contact phone number" },
    person: { ...ref("PersonInfo"), description: 'Person details — required when personType is "2" (natural person)' },
    corporateRegistration: {
      ...ref("CorporateRegistration"),
      description: "Corporate registration scheme — contains invoice prefix for supplier (FAB10a)",
    },
  },
  required: ["name", "identification", "personType", "fiscalResponsibilities", "taxInfo", "address"],
};

const TaxSubtotal = {
  type: "object",
  description: "Individual tax subtotal within a TaxTotal group. Represents one tax calculation line (e.g., 19% IVA on a taxable base).",
  properties: {
    taxableAmount: { type: "number", description: "Taxable base amount before tax is applied" },
    taxAmount: { type: "number", description: "Calculated tax amount (taxableAmount * percent / 100)" },
    percent: { type: "number", description: "Tax rate percentage (e.g., 19 for 19% IVA)" },
    taxScheme: { ...ref("TaxScheme"), description: "Tax scheme identifying which tax this subtotal belongs to" },
  },
  required: ["taxableAmount", "taxAmount", "percent", "taxScheme"],
};

const TaxTotal = {
  type: "object",
  description: "Aggregated tax total containing one or more tax subtotals. Groups related tax calculations (e.g., all IVA subtotals) under a single TaxTotal element.",
  properties: {
    taxAmount: { type: "number", description: "Total tax amount, sum of all subtotal taxAmount values" },
    subtotals: {
      type: "array",
      items: ref("TaxSubtotal"),
      description: "Individual tax calculation lines within this group",
    },
  },
  required: ["taxAmount", "subtotals"],
};

const AllowanceCharge = {
  type: "object",
  description: "Represents an allowance (discount) or charge (surcharge) applied to a document or line. Used in UBL AllowanceCharge elements at both document and line level.",
  properties: {
    chargeIndicator: { type: "boolean", description: "true for a charge (surcharge), false for an allowance (discount)" },
    reason: { type: "string", description: "Textual reason for the allowance or charge" },
    amount: { type: "number", description: "Monetary amount of the allowance or charge" },
    baseAmount: { type: "number", description: "Base amount on which the allowance/charge is calculated" },
    multiplierFactor: { type: "number", description: "Multiplier factor (percentage) used to calculate the amount from baseAmount" },
  },
  required: ["chargeIndicator", "reason", "amount", "baseAmount"],
};

const InvoiceLine = {
  type: "object",
  description: "Represents a single line item in a DIAN electronic document. Maps to InvoiceLine, CreditNoteLine, or DebitNoteLine UBL elements depending on the document type.",
  properties: {
    id: { type: "string", description: 'Sequential line identifier within the document (e.g., "1", "2")' },
    quantity: { type: "number", description: "Quantity of items (must be positive)" },
    unitCode: {
      type: "string",
      description: 'UN/ECE Recommendation 20 unit code (e.g., "EA" for each, "KGM" for kilogram), defaults to "EA"',
    },
    description: { type: "string", description: "Description of the good or service" },
    standardItemCode: {
      type: "string",
      description:
        'Standard/internal code identifying the good or service (DIAN requires every line to carry one - "Debe existir el grupo de informacion de identificacion del bien o servicio", rejection code FAZ09). Rendered as cac:StandardItemIdentification/cbc:ID with schemeID="999" ("Estandar de adopcion del contribuyente"), so any self-adopted code (not necessarily a formal UNSPSC code) is valid here. Defaults to "N/A" when omitted.',
    },
    price: { type: "number", description: "Unit price before taxes" },
    lineExtensionAmount: { type: "number", description: "Total line amount before taxes (quantity * price, adjusted for allowances/charges)" },
    allowanceCharges: {
      type: "array",
      items: ref("AllowanceCharge"),
      description: "Line-level allowances (discounts) and charges (surcharges)",
    },
    taxTotals: {
      type: "array",
      items: ref("TaxTotal"),
      description: "Tax totals applicable to this line item",
    },
  },
  required: ["id", "quantity", "description", "price", "lineExtensionAmount", "taxTotals"],
};

const LegalMonetaryTotal = {
  type: "object",
  description: "Legal monetary totals summarizing all amounts in the electronic document. Maps to the UBL LegalMonetaryTotal element with DIAN-required fields.",
  properties: {
    lineExtensionAmount: { type: "number", description: "Sum of all line extension amounts (subtotal before taxes)" },
    taxExclusiveAmount: { type: "number", description: "Total amount excluding taxes" },
    taxInclusiveAmount: { type: "number", description: "Total amount including all taxes" },
    allowanceTotalAmount: { type: "number", description: "Sum of all document-level and line-level allowances (discounts)" },
    chargeTotalAmount: { type: "number", description: "Sum of all document-level and line-level charges (surcharges)" },
    prepaidAmount: { type: "number", description: "Amount already paid in advance" },
    payableAmount: {
      type: "number",
      description:
        "Final amount due for payment (taxInclusiveAmount - allowances + charges - prepaid). Must equal taxInclusiveAmount - allowanceTotalAmount + chargeTotalAmount - prepaidAmount.",
    },
  },
  required: [
    "lineExtensionAmount",
    "taxExclusiveAmount",
    "taxInclusiveAmount",
    "allowanceTotalAmount",
    "chargeTotalAmount",
    "prepaidAmount",
    "payableAmount",
  ],
};

const PaymentMeans = {
  type: "object",
  description: "Payment means information specifying how the document will be paid. Maps to the UBL PaymentMeans element.",
  properties: {
    paymentForm: {
      type: "string",
      enum: ["1", "2"],
      description: '"1" for cash/immediate (Contado), "2" for credit/deferred (Credito)',
    },
    paymentMethod: {
      type: "string",
      enum: ["10", "20", "30", "42", "47", "48", "49", "ZZZ"],
      description:
        'Payment method code: "10" Efectivo, "20" Cheque, "30" Transferencia Credito, "42" Consignacion Bancaria, "47" Transferencia Debito, "48" Tarjeta de Credito, "49" Tarjeta Debito, "ZZZ" Otro.',
    },
    dueDate: { type: "string", format: "date-time", description: 'Payment due date, required when paymentForm is credit ("2")' },
    paymentId: { type: "string", description: "Payment reference identifier (e.g., bank reference number)" },
  },
  required: ["paymentForm", "paymentMethod"],
};

const InvoicePeriod = {
  type: "object",
  description: "Billing period for the electronic document. Used in the UBL InvoicePeriod element to specify the service or billing date range.",
  properties: {
    startDate: { type: "string", format: "date-time", description: "Start date of the billing period" },
    endDate: { type: "string", format: "date-time", description: "End date of the billing period" },
  },
  required: ["startDate", "endDate"],
};

const BillingReference = {
  type: "object",
  description:
    "Reference to the original invoice being corrected by a credit or debit note. Maps to the UBL BillingReference/InvoiceDocumentReference element. NOT part of the HTTP request body — the server derives this itself from the `invoiceId` you provide (see CreateNoteRequest), so it never disagrees with the referenced Invoice.",
  properties: {
    id: { type: "string", description: 'Document number of the original invoice (e.g., "SETT1")' },
    uuid: { type: "string", description: "CUFE/CUDE of the original invoice" },
    issueDate: { type: "string", format: "date-time", description: "Issue date of the original invoice" },
  },
  required: ["id", "uuid", "issueDate"],
};

const DiscrepancyResponseFull = {
  type: "object",
  description:
    "Discrepancy response data for credit and debit notes. Explains why the original invoice is being corrected, as required by DIAN. Maps to the UBL DiscrepancyResponse element. This is the full dian-kit SDK shape (includes `referenceId`); the HTTP request body only accepts `responseCode`/`description` — see DiscrepancyInput — the server always derives `referenceId` from the invoice you reference via `invoiceId`, so a caller can never make it disagree with the invoice actually being corrected.",
  properties: {
    referenceId: { type: "string", description: "Document number of the original invoice being corrected" },
    responseCode: {
      type: "string",
      description:
        'DIAN correction code. For credit notes: "1" Devolucion parcial, "2" Anulacion, "3" Rebaja o descuento, "4" Ajuste de precio. For debit notes: "1" Intereses, "2" Gastos por cobrar, "3" Cambio de valor.',
    },
    description: { type: "string", description: "Free-text description of the reason for the credit/debit note" },
  },
  required: ["referenceId", "responseCode", "description"],
};

const DiscrepancyInput = {
  type: "object",
  description:
    "What the caller supplies for a credit/debit note's DiscrepancyResponse. `referenceId` is intentionally not accepted here — the service derives it from the referenced invoice (`invoiceId`), so it can never disagree with `billingReference`.",
  properties: {
    responseCode: {
      type: "string",
      description:
        'DIAN correction code. For credit notes: "1" Devolucion parcial, "2" Anulacion, "3" Rebaja o descuento, "4" Ajuste de precio. For debit notes: "1" Intereses, "2" Gastos por cobrar, "3" Cambio de valor.',
    },
    description: { type: "string", description: "Free-text description of the reason for the credit/debit note" },
  },
  required: ["responseCode", "description"],
};

const SendOptions = {
  type: "object",
  description:
    "Options for sending a signed document to DIAN's SOAP web service. In production, use SendBillSync (the default) for immediate validation. During the DIAN qualification (habilitacion) process, use SendTestSetAsync with the assigned test set ID.",
  properties: {
    method: {
      type: "string",
      enum: ["SendBillSync", "SendBillAsync", "SendTestSetAsync"],
      description:
        '"SendBillSync" -- Production, returns validation result immediately (default). "SendBillAsync" -- Production, returns a trackId for deferred status checking. "SendTestSetAsync" -- Sandbox, submits to a test set; requires testSetId.',
    },
    testSetId: {
      type: "string",
      description:
        "Test set ID assigned by DIAN during the qualification (habilitacion) process. Required when method is SendTestSetAsync. Obtained from the DIAN portal under the software qualification section.",
    },
  },
};

const DocumentInputCore = {
  type: "object",
  description:
    "Shared per-document data accepted for credit notes, debit notes, and support documents (the `document` field of POST .../credit-notes, .../debit-notes, and .../support-documents), and the base of InvoiceInput. Static emitter information (supplier, software, numbering) is configured once on the company/certificate side, not sent per request.",
  properties: {
    id: {
      type: "string",
      description:
        'Document number including the authorized prefix (e.g., "SETP990000001") in the dian-kit SDK shape. Over this HTTP API it is optional and ignored if sent — the server always claims the next number from the company\'s active DIAN numbering resolution and overwrites this value.',
    },
    issueDate: {
      type: "string",
      format: "date-time",
      description: "Date on which the document is issued. DIAN requires the issue date to match the actual date of issuance — backdating is not permitted.",
    },
    issueTime: {
      type: "string",
      format: "date-time",
      description: "Time at which the document is issued. Used together with issueDate for CUFE/CUDE computation and included in the UBL XML as IssueTime.",
    },
    currency: { type: "string", description: 'ISO 4217 currency code. Defaults to "COP" (Colombian Peso).' },
    customer: {
      ...ref("Party"),
      description:
        "Customer (buyer / acquirer) party information. Includes the buyer's legal name, identification (NIT, CC, etc.), address, tax information, and fiscal responsibilities.",
    },
    lines: {
      type: "array",
      items: ref("InvoiceLine"),
      minItems: 1,
      description: "Line items. Each line represents a product or service, including quantity, unit price, extension amount, and per-line tax totals. Line IDs must be sequential starting from \"1\".",
    },
    taxTotals: {
      type: "array",
      items: ref("TaxTotal"),
      description: "Aggregated tax totals for the entire document. Each entry groups tax subtotals by tax scheme (e.g., IVA 19%, ICA, INC). Must be consistent with the per-line tax totals.",
    },
    allowanceCharges: {
      type: "array",
      items: ref("AllowanceCharge"),
      description:
        "Document-level allowances (discounts) or charges (surcharges). Applies to the whole document rather than any single line — distinct from each line's own allowanceCharges. Omit when there is no document-level discount/surcharge.",
    },
    withholdingTaxTotals: {
      type: "array",
      items: ref("TaxTotal"),
      description:
        "Retenciones (withholding taxes: ReteFuente, ReteICA, ReteIVA - TaxCode 05/06/07) withheld by the buyer. Informational on the document itself — does NOT reduce legalMonetaryTotal.payableAmount.",
    },
    legalMonetaryTotal: {
      ...ref("LegalMonetaryTotal"),
      description: "Legal monetary total summarizing all amounts in the document.",
    },
    paymentMeans: {
      ...ref("PaymentMeans"),
      description: "Payment means describing how the invoice will be paid.",
    },
    period: { ...ref("InvoicePeriod"), description: "Billing period for the invoice, if applicable." },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "Free-text notes to include in the document. Each string is rendered as a separate <cbc:Note> element in the UBL XML.",
    },
  },
  required: ["issueDate", "issueTime", "customer", "lines", "taxTotals", "legalMonetaryTotal", "paymentMeans"],
};

const InvoiceInput = {
  allOf: [
    ref("DocumentInputCore"),
    {
      type: "object",
      properties: {
        documentType: {
          type: "string",
          enum: ["01", "20"],
          description: '"01" Factura de Venta (standard electronic invoice), "20" Documento Equivalente POS. Defaults to "01".',
        },
        operationType: {
          type: "string",
          enum: ["10"],
          description: '"10" Estandar (standard operation). Defaults to "10".',
        },
      },
    },
  ],
  description:
    "Input for creating an electronic invoice (Factura Electronica, type 01) or a POS equivalent document (Documento Equivalente POS, type 20) — the `invoice` field of POST /api/v1/documents/invoices.",
  example: {
    issueDate: "2026-03-01T10:00:00-05:00",
    issueTime: "2026-03-01T10:00:00-05:00",
    customer: {
      name: "Cliente SAS",
      identification: { number: "800111222", type: "31", dv: "3" },
      personType: "1",
      fiscalResponsibilities: ["R-99-PN"],
      taxInfo: {
        registrationName: "Cliente SAS",
        companyId: { number: "800111222", type: "31", dv: "3" },
        taxLevelCode: "R-99-PN",
        taxScheme: { code: "01" },
      },
      address: {
        street: "Calle 100 #45-10",
        cityCode: "11001",
        cityName: "Bogota, D.C.",
        departmentCode: "11",
        departmentName: "Bogota",
      },
    },
    lines: [
      {
        id: "1",
        quantity: 2,
        description: "Servicio de consultoria",
        price: 500000,
        lineExtensionAmount: 1000000,
        taxTotals: [{ taxAmount: 190000, subtotals: [{ taxableAmount: 1000000, taxAmount: 190000, percent: 19, taxScheme: { code: "01" } }] }],
      },
    ],
    taxTotals: [{ taxAmount: 190000, subtotals: [{ taxableAmount: 1000000, taxAmount: 190000, percent: 19, taxScheme: { code: "01" } }] }],
    legalMonetaryTotal: {
      lineExtensionAmount: 1000000,
      taxExclusiveAmount: 1000000,
      taxInclusiveAmount: 1190000,
      allowanceTotalAmount: 0,
      chargeTotalAmount: 0,
      prepaidAmount: 0,
      payableAmount: 1190000,
    },
    paymentMeans: { paymentForm: "1", paymentMethod: "10" },
  },
};

const SupportDocumentInput = {
  ...ref("DocumentInputCore"),
  description:
    "Input for creating a Documento Soporte (Support Document, type \"05\") — a self-issued document for acquisitions from suppliers not obligated to issue an electronic invoice, required to support costs/deductions. This is the `document` field of POST /api/v1/documents/support-documents. documentType (\"05\") and operationType (\"10\") are set automatically by the server. Documento Soporte uses CUDE (software PIN), not CUFE. IMPORTANT — party roles are reversed from what the field name suggests: per DIAN's technical annex, AccountingSupplierParty in the resulting XML always holds the electronically-issuing party (ITCycle-registered company), which in real-world terms is the BUYER for this document type. The `customer` field must therefore hold the actual, real-world SELLER's identity (the non-obligated third party) — not literally \"the buyer\". Nothing in the type system enforces this; getting it backwards produces a structurally valid but semantically wrong document.",
};

const CreditNoteInput = {
  allOf: [
    ref("DocumentInputCore"),
    {
      type: "object",
      properties: {
        billingReference: ref("BillingReference"),
        discrepancyResponse: ref("DiscrepancyResponseFull"),
      },
      required: ["billingReference", "discrepancyResponse"],
    },
  ],
  description:
    "Input for creating a credit note (Nota Credito, type 91) in the dian-kit SDK shape. A credit note partially or fully reverses a previously issued invoice. documentType (\"91\") and operationType (\"20\") are set automatically. Over this HTTP API, the `document` field of POST /api/v1/documents/credit-notes only accepts the DocumentInputCore subset (no billingReference/discrepancyResponse) — see CreateNoteRequest; the server derives billingReference from the invoice referenced by `invoiceId`, and discrepancyResponse.referenceId from that same invoice, combining it with the request's own top-level `discrepancyResponse` (responseCode/description).",
};

const DebitNoteInput = {
  allOf: [
    ref("DocumentInputCore"),
    {
      type: "object",
      properties: {
        billingReference: ref("BillingReference"),
        discrepancyResponse: ref("DiscrepancyResponseFull"),
      },
      required: ["billingReference", "discrepancyResponse"],
    },
  ],
  description:
    "Input for creating a debit note (Nota Debito, type 92) in the dian-kit SDK shape. A debit note adjusts a previously issued invoice by increasing the amount owed. documentType (\"92\") and operationType (\"30\") are set automatically. Over this HTTP API, the `document` field of POST /api/v1/documents/debit-notes only accepts the DocumentInputCore subset (no billingReference/discrepancyResponse) — see CreateNoteRequest; the server derives billingReference from the invoice referenced by `invoiceId`, and discrepancyResponse.referenceId from that same invoice, combining it with the request's own top-level `discrepancyResponse` (responseCode/description).",
};

// --- Request envelopes (documents.schemas.ts) -------------------------------

const CreateInvoiceRequest = {
  type: "object",
  properties: {
    internalReference: {
      type: "string",
      description:
        "Caller-chosen idempotency key. A repeated internalReference for the same company returns the previously created invoice instead of creating a duplicate or re-sending to DIAN — unless the prior attempt is still PROCESSING, in which case the request fails with a 502 telling you to retry shortly.",
    },
    invoice: ref("InvoiceInput"),
    send: ref("SendOptions"),
  },
  required: ["internalReference", "invoice"],
};

const CreateNoteRequest = {
  type: "object",
  description: "Request body shared by POST /api/v1/documents/credit-notes and POST /api/v1/documents/debit-notes.",
  properties: {
    internalReference: {
      type: "string",
      description: "Caller-chosen idempotency key — same semantics as CreateInvoiceRequest.internalReference.",
    },
    invoiceId: {
      type: "string",
      description:
        "id of a previously created Invoice from this API (not a DIAN CUFE) — must belong to the same company and must already be ACCEPTED (with a known cufe/invoiceNumber/issuedAt), otherwise the request fails with a 502 error. The server derives billingReference and discrepancyResponse.referenceId from this invoice.",
    },
    document: {
      ...ref("DocumentInputCore"),
      description:
        "The note's own lines/taxTotals/legalMonetaryTotal/paymentMeans — same shape as InvoiceInput minus documentType/operationType/billingReference/discrepancyResponse, which the server injects itself.",
    },
    discrepancyResponse: ref("DiscrepancyInput"),
    send: ref("SendOptions"),
  },
  required: ["internalReference", "invoiceId", "document", "discrepancyResponse"],
};

const CreateSupportDocumentRequest = {
  type: "object",
  properties: {
    internalReference: {
      type: "string",
      description: "Caller-chosen idempotency key — same semantics as CreateInvoiceRequest.internalReference.",
    },
    document: ref("SupportDocumentInput"),
    send: ref("SendOptions"),
  },
  required: ["internalReference", "document"],
};

const CreateReceiptAcknowledgmentRequest = {
  type: "object",
  description:
    "Body for POST /api/v1/documents/receipt-acknowledgments — RADIAN buyer-side events (acuse de recibo / recibo del bien / aceptacion expresa / reclamo) for a THIRD-PARTY supplier's real DIAN invoice. PHASE 1 / SIMULATION ONLY: the server builds and signs a real, well-formed XML document locally but never actually transmits it to DIAN — there is no real DianProvider path for this document type yet, and the exact ApplicationResponse XML structure and DIAN's ResponseCode catalogue are unverified pending RADIAN's technical annex (Resolucion 000012 de 2021). No `send` field exists for this endpoint.",
  properties: {
    internalReference: {
      type: "string",
      description: "Caller-chosen idempotency key — same semantics as CreateInvoiceRequest.internalReference.",
    },
    eventType: {
      type: "string",
      enum: ["ACUSE_RECIBO", "RECIBO_BIEN", "ACEPTACION_EXPRESA", "RECLAMO"],
      description: "Which RADIAN buyer-side event this acknowledgment represents.",
    },
    referencedCufe: { type: "string", description: "The SUPPLIER's own invoice CUFE being acknowledged." },
    referencedInvoiceId: { type: "string", description: "The supplier's own invoice number, informational only." },
    responseCode: {
      type: "string",
      description: "Free-form response code — DIAN's real ResponseCode catalogue for this event family is unknown pending the annex.",
    },
    description: {
      type: "string",
      description:
        "Free-text description. If omitted, a default Spanish description is used based on eventType (not persisted back on the resulting record — used only to build the signed XML).",
    },
  },
  required: ["internalReference", "eventType", "referencedCufe"],
};

const RetrySendRequest = {
  type: "object",
  description: "Body for POST .../:id/retry-send. The body itself is optional (an empty body is treated as `{}`).",
  properties: {
    send: ref("SendOptions"),
  },
};

// --- Response schemas (Prisma models, as literally returned) ---------------

const DocumentStatus = {
  type: "string",
  enum: ["PENDING", "PROCESSING", "SENT", "ACCEPTED", "REJECTED", "ERROR", "CONTINGENCY"],
  description:
    "PROCESSING only exists transiently between document creation and its final status update — seeing it on a GET means a concurrent request for the same internalReference is still mid-flight (or was orphaned by a crash/redeploy). CONTINGENCY means DIAN was unreachable when sending; retry via the .../:id/retry-send endpoint.",
};

const CertificateSummary = {
  type: "object",
  nullable: true,
  description:
    "The certificate that signed (or will sign) this document, as it is genuinely included on every document response from this API (`include: { certificate: true }`). Null only if the document row has no certificateId set.",
  properties: {
    id: { type: "string" },
    companyId: { type: "string" },
    provider: { type: "string", description: 'e.g. "firmapass" or "viafirma"' },
    certificateIdentifier: { type: "string", description: "Provider-side reference, not the certificate itself" },
    secretReference: { type: "string", description: "Pointer into the server's CertificateSecretStore — not a secret value itself, but an internal storage key." },
    expiresAt: { type: "string", format: "date-time", nullable: true },
    status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
    providerMetadata: { type: "object", nullable: true, additionalProperties: true, description: "Provider-specific, non-secret metadata." },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const InvoiceResponse = {
  type: "object",
  description: "An electronic invoice (Factura de Venta) issued by a company — the persisted Invoice record, exactly as returned by the API.",
  properties: {
    id: { type: "string" },
    companyId: { type: "string" },
    numberingId: { type: "string", nullable: true },
    certificateId: { type: "string", nullable: true },
    internalReference: { type: "string", description: "Idempotency key (e.g. Idempotency-Key header)" },
    invoiceNumber: { type: "string", nullable: true, description: 'Full number, e.g. "SETP990000001"' },
    prefix: { type: "string", nullable: true },
    cufe: { type: "string", nullable: true },
    status: ref("DocumentStatus"),
    trackId: {
      type: "string",
      nullable: true,
      description: "ZipKey/UUID DIAN returns for an async send (SendBillAsync/SendTestSetAsync) — null for sync sends.",
    },
    statusDescription: { type: "string", nullable: true, description: "Latest human-readable status text from DIAN — not authoritative on its own, `status` is." },
    simulated: {
      type: "boolean",
      description: "True when `send` went through the simulated DIAN provider instead of a real DIAN connection (DIAN_SIMULATION_MODE). ACCEPTED + simulated=true is NOT a real DIAN acceptance.",
    },
    xmlReference: { type: "string", nullable: true, description: "Pointer to stored signed XML (not inlined here)" },
    dianResponseReference: { type: "string", nullable: true, description: "Pointer to stored raw DIAN response" },
    issuedAt: { type: "string", format: "date-time", nullable: true },
    sentAt: { type: "string", format: "date-time", nullable: true },
    acceptedAt: { type: "string", format: "date-time", nullable: true },
    rejectedAt: { type: "string", format: "date-time", nullable: true },
    errorCode: { type: "string", nullable: true },
    errorMessage: { type: "string", nullable: true },
    testSetId: { type: "string", nullable: true, description: "The send.testSetId this document was submitted under, if any." },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    certificate: ref("CertificateSummary"),
  },
  required: ["id", "companyId", "internalReference", "status", "simulated", "createdAt", "updatedAt"],
};

const NoteResponseBase = {
  type: "object",
  properties: {
    id: { type: "string" },
    companyId: { type: "string" },
    invoiceId: { type: "string", description: "The Invoice this note corrects." },
    numberingId: { type: "string", nullable: true },
    certificateId: { type: "string", nullable: true },
    internalReference: { type: "string", description: "Idempotency key" },
    noteNumber: { type: "string", nullable: true, description: 'Full number, e.g. "NC0000001"' },
    prefix: { type: "string", nullable: true },
    cufe: { type: "string", nullable: true },
    discrepancyResponseCode: { type: "string" },
    discrepancyDescription: { type: "string" },
    status: ref("DocumentStatus"),
    trackId: { type: "string", nullable: true },
    statusDescription: { type: "string", nullable: true },
    simulated: { type: "boolean" },
    xmlReference: { type: "string", nullable: true },
    dianResponseReference: { type: "string", nullable: true },
    issuedAt: { type: "string", format: "date-time", nullable: true },
    sentAt: { type: "string", format: "date-time", nullable: true },
    acceptedAt: { type: "string", format: "date-time", nullable: true },
    rejectedAt: { type: "string", format: "date-time", nullable: true },
    errorCode: { type: "string", nullable: true },
    errorMessage: { type: "string", nullable: true },
    testSetId: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    certificate: ref("CertificateSummary"),
  },
  required: ["id", "companyId", "invoiceId", "internalReference", "discrepancyResponseCode", "discrepancyDescription", "status", "simulated", "createdAt", "updatedAt"],
};

const CreditNoteResponse = {
  ...NoteResponseBase,
  description: 'A credit note (Nota Credito, DIAN type 91) that partially or fully reverses a previously issued, ACCEPTED Invoice — the persisted CreditNote record, exactly as returned by the API. discrepancyResponseCode e.g. "2" = anulacion.',
};

const DebitNoteResponse = {
  ...NoteResponseBase,
  description: 'A debit note (Nota Debito, DIAN type 92) that adjusts a previously issued invoice — the persisted DebitNote record, exactly as returned by the API. discrepancyResponseCode e.g. "1" = intereses.',
};

const SupportDocumentResponse = {
  type: "object",
  description: "A Documento Soporte (type 05) — the persisted SupportDocument record, exactly as returned by the API.",
  properties: {
    id: { type: "string" },
    companyId: { type: "string" },
    numberingId: { type: "string", nullable: true },
    certificateId: { type: "string", nullable: true },
    internalReference: { type: "string" },
    documentNumber: { type: "string", nullable: true, description: 'Full number, e.g. "DSNO0000001"' },
    prefix: { type: "string", nullable: true },
    cufe: { type: "string", nullable: true, description: "CUDE, despite the field name (matches Invoice/CreditNote/DebitNote's own convention)." },
    status: ref("DocumentStatus"),
    simulated: { type: "boolean" },
    xmlReference: { type: "string", nullable: true },
    dianResponseReference: { type: "string", nullable: true },
    issuedAt: { type: "string", format: "date-time", nullable: true },
    sentAt: { type: "string", format: "date-time", nullable: true },
    acceptedAt: { type: "string", format: "date-time", nullable: true },
    rejectedAt: { type: "string", format: "date-time", nullable: true },
    errorCode: { type: "string", nullable: true },
    errorMessage: { type: "string", nullable: true },
    testSetId: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    certificate: ref("CertificateSummary"),
  },
  required: ["id", "companyId", "internalReference", "status", "simulated", "createdAt", "updatedAt"],
};

const ReceiptAcknowledgmentResponse = {
  type: "object",
  description:
    "A buyer-side RADIAN acknowledgment event for a third-party supplier's invoice — the persisted ReceiptAcknowledgment record, exactly as returned by the API. Phase 1: `simulated` defaults to true, since there is no real, non-simulated send path for this document type yet.",
  properties: {
    id: { type: "string" },
    companyId: { type: "string" },
    certificateId: { type: "string", nullable: true },
    internalReference: { type: "string" },
    eventType: { type: "string", enum: ["ACUSE_RECIBO", "RECIBO_BIEN", "ACEPTACION_EXPRESA", "RECLAMO"] },
    referencedCufe: { type: "string" },
    referencedInvoiceId: { type: "string", nullable: true },
    responseCode: { type: "string", nullable: true },
    status: ref("DocumentStatus"),
    simulated: { type: "boolean" },
    xmlReference: { type: "string", nullable: true },
    dianResponseReference: { type: "string", nullable: true },
    issuedAt: { type: "string", format: "date-time", nullable: true },
    sentAt: { type: "string", format: "date-time", nullable: true },
    acceptedAt: { type: "string", format: "date-time", nullable: true },
    rejectedAt: { type: "string", format: "date-time", nullable: true },
    errorCode: { type: "string", nullable: true },
    errorMessage: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    certificate: ref("CertificateSummary"),
  },
  required: ["id", "companyId", "internalReference", "eventType", "referencedCufe", "status", "simulated", "createdAt", "updatedAt"],
};

// --- Shared error responses --------------------------------------------------

const UnauthorizedError = {
  type: "object",
  description: "Returned by requireApiKey when the x-api-key header is missing, unknown, or belongs to an inactive key/company.",
  properties: {
    error: { type: "string", enum: ["unauthorized"] },
    message: { type: "string", enum: ["Missing x-api-key header", "Invalid or inactive API key"] },
  },
  required: ["error", "message"],
};

const NotFoundError = {
  type: "object",
  properties: {
    error: { type: "string", enum: ["not_found"] },
  },
  required: ["error"],
};

const DianSendFailedError = {
  type: "object",
  description: "Returned when document creation/signing succeeded locally but sending to DIAN (or another step in the request) threw — see the specific error's `message` for detail.",
  properties: {
    error: { type: "string", enum: ["dian_send_failed"] },
    message: { type: "string" },
  },
  required: ["error", "message"],
};

const ReceiptAcknowledgmentFailedError = {
  type: "object",
  properties: {
    error: { type: "string", enum: ["receipt_acknowledgment_failed"] },
    message: { type: "string" },
  },
  required: ["error", "message"],
};

function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

const security = [{ ApiKeyAuth: [] }];

function jsonBody(schemaName: string) {
  return { required: true, content: { "application/json": { schema: ref(schemaName) } } };
}

function jsonResponse(description: string, schemaName?: string) {
  return {
    description,
    content: schemaName ? { "application/json": { schema: ref(schemaName) } } : undefined,
  };
}

const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The document's own id (from the create/list response), not its DIAN document number or CUFE.",
};

/**
 * Builds the create/get(/retry-send) path item trio shared by invoices,
 * credit notes, debit notes, and support documents — the four document
 * families whose route files (invoice.route.ts, creditNote.route.ts,
 * debitNote.route.ts, supportDocument.route.ts) all follow this exact
 * pattern (verified by reading each file: same statuses, same error shapes,
 * only the path segment and schema names differ).
 */
function documentPaths(
  basePath: string,
  summaryNoun: string,
  createRequestSchema: string,
  responseSchema: string,
): Record<string, unknown> {
  return {
    [basePath]: {
      post: {
        summary: `Create a ${summaryNoun}`,
        tags: [summaryNoun],
        security,
        requestBody: jsonBody(createRequestSchema),
        responses: {
          "201": jsonResponse(`${summaryNoun} created (or, for a repeated internalReference, the previously created one returned as-is).`, responseSchema),
          "401": jsonResponse("Missing or invalid x-api-key.", "UnauthorizedError"),
          "502": jsonResponse("Local signing succeeded but the request failed (e.g. sending to DIAN failed, or the referenced invoiceId is invalid/not ACCEPTED).", "DianSendFailedError"),
        },
      },
    },
    [`${basePath}/{id}`]: {
      get: {
        summary: `Get a ${summaryNoun} by id`,
        tags: [summaryNoun],
        security,
        parameters: [idParam],
        responses: {
          "200": jsonResponse(`The ${summaryNoun}.`, responseSchema),
          "401": jsonResponse("Missing or invalid x-api-key.", "UnauthorizedError"),
          "404": jsonResponse("No such document for this company.", "NotFoundError"),
        },
      },
    },
    [`${basePath}/{id}/retry-send`]: {
      post: {
        summary: `Retry sending a CONTINGENCY ${summaryNoun} to DIAN`,
        tags: [summaryNoun],
        security,
        parameters: [idParam],
        description:
          "Reuses the exact previously-signed XML (never regenerated) and the same document number/CUFE already issued. Only valid when the document is CONTINGENCY (or SENT with no trackId).",
        requestBody: { required: false, content: { "application/json": { schema: ref("RetrySendRequest") } } },
        responses: {
          "200": jsonResponse(`The ${summaryNoun}, updated with the new send outcome.`, responseSchema),
          "401": jsonResponse("Missing or invalid x-api-key.", "UnauthorizedError"),
          "502": jsonResponse("Send failed again (e.g. DIAN still unreachable), or the document was not in a retryable state.", "DianSendFailedError"),
        },
      },
    },
  };
}

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "itcycle-api-dian - Facturacion electronica DIAN API",
    version: "0.1.0",
    description:
      "Ohnix's own DIAN e-invoicing engine (software propio, not a Factus/Alanube reseller) — the customer-facing document API that an external company's own POS/ERP/SaaS calls directly with its own x-api-key to issue Colombian DIAN electronic documents: facturas, notas credito/debito, documentos soporte, and (Phase 1/simulation only) RADIAN receipt acknowledgments. Tenant provisioning and internal/dev-only routes are not part of this document.",
  },
  servers: [
    {
      url: "https://itcycle-api-dian.onrender.com",
      description: "Production",
    },
  ],
  tags: [
    { name: "Invoice", description: "Factura Electronica de Venta (type 01) / POS equivalent document (type 20)." },
    { name: "Credit Note", description: "Nota Credito (type 91) — reverses a previously ACCEPTED invoice." },
    { name: "Debit Note", description: "Nota Debito (type 92) — adjusts a previously issued invoice." },
    { name: "Support Document", description: "Documento Soporte (type 05) — self-issued document for non-obligated suppliers." },
    { name: "Receipt Acknowledgment", description: "RADIAN buyer-side acknowledgment events. Phase 1 / simulation only." },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description:
          "Per-company API key (see src/shared/apiKeyAuth.ts). Looked up against a stored key hash; the owning company is derived from the key itself and can never be overridden by anything in the request body.",
      },
    },
    schemas: {
      Address,
      PartyIdentification,
      TaxScheme,
      PartyTaxInfo,
      PersonInfo,
      CorporateRegistration,
      Party,
      TaxSubtotal,
      TaxTotal,
      AllowanceCharge,
      InvoiceLine,
      LegalMonetaryTotal,
      PaymentMeans,
      InvoicePeriod,
      BillingReference,
      DiscrepancyResponseFull,
      DiscrepancyInput,
      SendOptions,
      DocumentInputCore,
      InvoiceInput,
      SupportDocumentInput,
      CreditNoteInput,
      DebitNoteInput,
      CreateInvoiceRequest,
      CreateNoteRequest,
      CreateSupportDocumentRequest,
      CreateReceiptAcknowledgmentRequest,
      RetrySendRequest,
      DocumentStatus,
      CertificateSummary,
      InvoiceResponse,
      CreditNoteResponse,
      DebitNoteResponse,
      SupportDocumentResponse,
      ReceiptAcknowledgmentResponse,
      UnauthorizedError,
      NotFoundError,
      DianSendFailedError,
      ReceiptAcknowledgmentFailedError,
    },
  },
  paths: {
    ...documentPaths("/api/v1/documents/invoices", "Invoice", "CreateInvoiceRequest", "InvoiceResponse"),
    ...documentPaths("/api/v1/documents/credit-notes", "Credit Note", "CreateNoteRequest", "CreditNoteResponse"),
    ...documentPaths("/api/v1/documents/debit-notes", "Debit Note", "CreateNoteRequest", "DebitNoteResponse"),
    ...documentPaths("/api/v1/documents/support-documents", "Support Document", "CreateSupportDocumentRequest", "SupportDocumentResponse"),
    "/api/v1/documents/receipt-acknowledgments": {
      post: {
        summary: "Create a receipt acknowledgment (RADIAN buyer-side event)",
        tags: ["Receipt Acknowledgment"],
        security,
        description: "Phase 1 / simulation only — see CreateReceiptAcknowledgmentRequest's description.",
        requestBody: jsonBody("CreateReceiptAcknowledgmentRequest"),
        responses: {
          "201": jsonResponse("Receipt acknowledgment created (or, for a repeated internalReference, the previously created one returned as-is).", "ReceiptAcknowledgmentResponse"),
          "401": jsonResponse("Missing or invalid x-api-key.", "UnauthorizedError"),
          "502": jsonResponse("Failed — e.g. DIAN_SIMULATION_MODE is not enabled server-side (this endpoint has no real-DIAN path yet).", "ReceiptAcknowledgmentFailedError"),
        },
      },
    },
    "/api/v1/documents/receipt-acknowledgments/{id}": {
      get: {
        summary: "Get a receipt acknowledgment by id",
        tags: ["Receipt Acknowledgment"],
        security,
        parameters: [idParam],
        responses: {
          "200": jsonResponse("The receipt acknowledgment.", "ReceiptAcknowledgmentResponse"),
          "401": jsonResponse("Missing or invalid x-api-key.", "UnauthorizedError"),
          "404": jsonResponse("No such document for this company.", "NotFoundError"),
        },
      },
    },
  },
};
