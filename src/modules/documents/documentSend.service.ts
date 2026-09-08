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

/**
 * The DIAN only requires ONE accepted document per type to flip a "modo de
 * operación" from "En proceso" to "Aceptado" - it does not wait for the full
 * habilitación batch. Once that happens, every further SendTestSetAsync
 * document against the same testSetId comes back with `isValid: false` and
 * this exact message, even though nothing is actually wrong with the
 * document itself - habilitación is just already done. Treating that as a
 * genuine REJECTED (the naive isValid-based mapping) is wrong two ways: it
 * shows as a red rejection in test-matrix UIs for something that isn't a
 * failure, and — more importantly — a REJECTED invoice can't be referenced
 * by a credit/debit note (see createCreditNote/createDebitNote's own
 * ACCEPTED check), so every note in the same run fails as an unrelated-
 * looking cascade. Both call sites that turn `isValid` into a persisted
 * ACCEPTED/REJECTED status route through this so the canonical status is
 * correct everywhere at once, not just cosmetically relabeled downstream.
 */
export function isTestSetAlreadyAcceptedMessage(statusDescription: string | null | undefined): boolean {
  return /se encuentra aceptado/i.test(statusDescription ?? "");
}

/**
 * A second, distinct non-terminal case DIAN's async endpoints can return:
 * the batch was accepted for later validation but DIAN's ack carries no
 * ZipKey/XmlFileName (see dian-engine's parseSendResponse — that's the only
 * source of `trackId`), so there is nothing to poll GetStatusZip with. Since
 * `computeSentStatusFields` only recognizes "SENT" via a present `trackId`,
 * this used to fall straight into the naive isValid-based mapping and get
 * recorded as a permanent REJECTED, even though DIAN never actually
 * rejected it — it just hasn't validated it yet. The only way to learn the
 * real verdict is to resend later (see invoice/creditNote/debitNote
 * .service.ts's retryXxxSend and contingencyRetry.job.ts, which now also
 * sweeps this case, not just CONTINGENCY).
 */
export function isStillValidatingMessage(statusDescription: string | null | undefined): boolean {
  return /en proceso de validaci/i.test(statusDescription ?? "");
}

export interface SentStatusFields {
  status: "SENT" | "ACCEPTED" | "REJECTED";
  trackId: string | null;
  statusDescription: string | null;
  acceptedAt: Date | null;
  errorMessage: string | null;
}

/**
 * Computes the status fields to persist from a "sent" SendOutcome.
 *
 * `SendBillSync` responses have no `trackId` and already carry DIAN's real
 * verdict in `isValid` — those resolve immediately to ACCEPTED/REJECTED,
 * exactly as before this function existed.
 *
 * `SendBillAsync`/`SendTestSetAsync` responses DO have a `trackId` — their
 * `isValid` on THIS response is only DIAN's acknowledgment that the document
 * was received for processing, not the final validation result (dian-kit.ts
 * documents this: the real result requires a later `getStatusZip(trackId)`
 * call). Treating that ack as final was a latent bug: a batch of async sends
 * could get recorded as "accepted" without DIAN ever having validated them.
 * These now land in the intermediate "SENT" status with `trackId` persisted;
 * admin.service.ts's `refreshDocumentStatus` polls `getStatusZip` later to
 * resolve the real ACCEPTED/REJECTED verdict.
 */
export function computeSentStatusFields(response: DianSendResponse): SentStatusFields {
  if (response.trackId) {
    return {
      status: "SENT",
      trackId: response.trackId,
      statusDescription: response.statusDescription ?? null,
      acceptedAt: null,
      errorMessage: null,
    };
  }
  if (!response.isValid && isStillValidatingMessage(response.statusDescription)) {
    return {
      status: "SENT",
      trackId: null,
      statusDescription: response.statusDescription ?? null,
      acceptedAt: null,
      errorMessage: null,
    };
  }
  const accepted = response.isValid || isTestSetAlreadyAcceptedMessage(response.statusDescription);
  return {
    status: accepted ? "ACCEPTED" : "REJECTED",
    trackId: null,
    statusDescription: response.statusDescription ?? null,
    acceptedAt: accepted ? new Date() : null,
    errorMessage: response.errors?.map((e) => e.description).join("; ") || null,
  };
}
