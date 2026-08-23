import { DianTransportError, type DianSendResponse, type DocumentResult, type SendOptions } from "@dian-kit/sdk-node";

import type { DianProvider } from "../../providers/dian/DianProvider.js";

export type SendOutcome =
  | { kind: "sent"; response: DianSendResponse }
  | { kind: "contingency"; error: DianTransportError };

/**
 * Wraps provider.send() to distinguish the one case DIAN's own regulation
 * treats specially: the service being unreachable (network error, timeout,
 * non-2xx from DIAN — see dian-engine's postSoap()), which `@dian-kit/sdk-node`
 * always surfaces as `DianTransportError`. That case is legally a
 * "contingencia atribuible a la DIAN": the document was already built and
 * signed successfully, so it can — and must — be delivered to the customer;
 * only DIAN's validation is deferred (see invoice.service.ts callers).
 *
 * Any other exception is rethrown as-is — this helper only classifies
 * DianTransportError, it never assumes a failure is contingency-eligible
 * just because send() failed.
 */
export async function sendWithContingencyHandling(
  provider: DianProvider,
  document: DocumentResult,
  sendOptions?: SendOptions,
): Promise<SendOutcome> {
  try {
    const response = await provider.send(document, sendOptions);
    return { kind: "sent", response };
  } catch (error) {
    if (error instanceof DianTransportError) {
      return { kind: "contingency", error };
    }
    throw error;
  }
}

/** Minimal DocumentResult reconstruction for retry-send — see documentSend.service.ts's module comment: provider.send() only ever reads signedXml + documentNumber. */
export function reconstructDocumentForResend(signedXml: string, documentNumber: string, uuid: string): DocumentResult {
  return { xml: signedXml, signedXml, documentNumber, uuid };
}
