import { DianKit, type DianKitConfig } from "@dian-kit/sdk-node";

import type { DianProvider } from "./DianProvider.js";

/**
 * {@link DianProvider} implementation backed by the vendored `dian-kit`
 * engine (`./dian-kit`, git submodule). Purely delegates to a `DianKit`
 * instance — no DIAN logic (UBL, XAdES, CUFE/CUDE, SOAP) belongs here.
 */
export class DianKitProvider implements DianProvider {
  private readonly kit: DianKit;

  constructor(config: DianKitConfig) {
    this.kit = new DianKit(config);
  }

  createInvoice: DianProvider["createInvoice"] = (input) => this.kit.createInvoice(input);

  createCreditNote: DianProvider["createCreditNote"] = (input) => this.kit.createCreditNote(input);

  createDebitNote: DianProvider["createDebitNote"] = (input) => this.kit.createDebitNote(input);

  send: DianProvider["send"] = (document, options) => this.kit.send(document, options);

  getStatus: DianProvider["getStatus"] = (trackId) => this.kit.getStatus(trackId);

  getStatusZip: DianProvider["getStatusZip"] = (trackId) => this.kit.getStatusZip(trackId);

  getNumberingRange: DianProvider["getNumberingRange"] = (accountCodeT) =>
    this.kit.getNumberingRange(accountCodeT);

  lookupBuyer: DianProvider["lookupBuyer"] = (options) => this.kit.lookupBuyer(options);
}
