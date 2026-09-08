import type { FastifyBaseLogger } from "fastify";

import { prisma } from "../infrastructure/prisma.js";

export interface ProcessingReconcileSummary {
  invoices: number;
  creditNotes: number;
  debitNotes: number;
  supportDocuments: number;
}

const ORPHANED_MESSAGE =
  "El servidor se reinició (o el proceso terminó de forma anormal) mientras se procesaba este documento - no se pudo confirmar si llegó a enviarse a la DIAN. Vuelve a intentarlo con un nuevo internalReference.";

/**
 * Recovers documents orphaned by a server restart (a deploy, a crash) while
 * still at "PROCESSING" — the status createInvoice/createCreditNote/
 * createDebitNote/createSupportDocument set the instant the row is created,
 * always overwritten by a terminal status (or ERROR) before their own
 * try/catch returns. A row still at PROCESSING can therefore only mean the
 * process that created it is gone — there is no legitimate way for it to
 * survive to a fresh process's own startup otherwise. Left alone, such a
 * document has no recovery path at all: retryXxxSend only accepts
 * CONTINGENCY/SENT documents (see invoice.service.ts), never PROCESSING, and
 * the idempotent-replay check in each createXxx now deliberately refuses to
 * silently hand back a PROCESSING snapshot (see createInvoice's own
 * comment) — so without this, a customer's request would just hang forever
 * with no way to tell if their document was ever delivered.
 *
 * Call once at server startup (see index.ts) — same reasoning as Ohnix's
 * reconcileOrphanedDianTestMatrixRuns: anything still PROCESSING at that
 * point can only be left over from before this process existed.
 */
export async function reconcileOrphanedProcessingDocuments(logger?: FastifyBaseLogger): Promise<ProcessingReconcileSummary> {
  const data = { status: "ERROR" as const, errorMessage: ORPHANED_MESSAGE };
  const [invoices, creditNotes, debitNotes, supportDocuments] = await Promise.all([
    prisma.invoice.updateMany({ where: { status: "PROCESSING" }, data }),
    prisma.creditNote.updateMany({ where: { status: "PROCESSING" }, data }),
    prisma.debitNote.updateMany({ where: { status: "PROCESSING" }, data }),
    prisma.supportDocument.updateMany({ where: { status: "PROCESSING" }, data }),
  ]);

  const summary: ProcessingReconcileSummary = {
    invoices: invoices.count,
    creditNotes: creditNotes.count,
    debitNotes: debitNotes.count,
    supportDocuments: supportDocuments.count,
  };
  const total = summary.invoices + summary.creditNotes + summary.debitNotes + summary.supportDocuments;
  if (total > 0) {
    logger?.warn({ summary }, `Reconciled ${total} document(s) orphaned in PROCESSING by a previous process`);
  }
  return summary;
}
