import { z } from "zod";

/**
 * Same permissive shape test-invoice.route.ts uses for `invoice`: dian-kit's
 * own Zod schema (assembleDocument, see dian-kit.ts) does the real structural
 * validation. ITCycle does not duplicate it here — see that file's comment.
 */
export const DocumentBodySchema = z.record(z.string(), z.unknown());

export const SendOptionsSchema = z
  .object({
    method: z.enum(["SendBillSync", "SendBillAsync", "SendTestSetAsync"]).optional(),
    testSetId: z.string().optional(),
  })
  .optional();

/**
 * What the caller supplies for a credit/debit note's DiscrepancyResponse.
 * `referenceId` is intentionally NOT accepted here — the service derives it
 * from the referenced Invoice, so it can never disagree with billingReference.
 */
export const DiscrepancyInputSchema = z.object({
  responseCode: z.string(),
  description: z.string(),
});

export const CreateInvoiceBodySchema = z.object({
  companyId: z.string(),
  internalReference: z.string(),
  invoice: DocumentBodySchema,
  send: SendOptionsSchema,
});

/**
 * Shared by both the credit-note and debit-note routes — `document` carries
 * the note's own lines/taxTotals/legalMonetaryTotal/paymentMeans (same shape
 * as `invoice` above, minus documentType/operationType/billingReference/
 * discrepancyResponse, which the service injects itself).
 */
export const CreateNoteBodySchema = z.object({
  companyId: z.string(),
  internalReference: z.string(),
  invoiceId: z.string(),
  document: DocumentBodySchema,
  discrepancyResponse: DiscrepancyInputSchema,
  send: SendOptionsSchema,
});
