import type {
  CreditNoteInput,
  DebitNoteInput,
  DianAcquirerResponse,
  DianNumberingRangeResponse,
  DianSendResponse,
  DianStatusResponse,
  DocumentResult,
  InvoiceInput,
  LookupBuyerOptions,
  SendOptions,
} from "@dian-kit/sdk-node";

/**
 * ITCycle's abstraction over a DIAN electronic-invoicing engine.
 *
 * Everything in ITCycle that needs to build, sign, or send a DIAN document
 * depends on this interface, never on `dian-kit` (or any other engine)
 * directly. This keeps the engine swappable/upgradeable without touching
 * callers — see {@link DianKitProvider} for the current implementation.
 */
export interface DianProvider {
  createInvoice(input: InvoiceInput): Promise<DocumentResult>;
  createCreditNote(input: CreditNoteInput): Promise<DocumentResult>;
  createDebitNote(input: DebitNoteInput): Promise<DocumentResult>;
  send(document: DocumentResult, options?: SendOptions): Promise<DianSendResponse>;
  getStatus(trackId: string): Promise<DianStatusResponse>;
  getStatusZip(trackId: string): Promise<DianStatusResponse>;
  getNumberingRange(accountCodeT?: string): Promise<DianNumberingRangeResponse>;
  lookupBuyer(options: LookupBuyerOptions): Promise<DianAcquirerResponse>;
}
