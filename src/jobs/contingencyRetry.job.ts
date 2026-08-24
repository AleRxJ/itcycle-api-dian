import type { FastifyBaseLogger } from "fastify";
import cron from "node-cron";

import { retryCreditNoteSend } from "../modules/documents/creditNote.service.js";
import { retryDebitNoteSend } from "../modules/documents/debitNote.service.js";
import type { DocumentServiceDeps } from "../modules/documents/invoice.service.js";
import { retryInvoiceSend } from "../modules/documents/invoice.service.js";
import { retrySupportDocumentSend } from "../modules/documents/supportDocument.service.js";
import { prisma } from "../infrastructure/prisma.js";
import { env } from "../shared/env.js";

export interface ContingencyRetrySummary {
  attempted: number;
  accepted: number;
  stillContingency: number;
  failed: number;
}

/**
 * Sweeps every company for CONTINGENCY invoices/credit notes/debit notes
 * (documents whose send() previously failed because DIAN itself was
 * unreachable — see documentSend.service.ts) and retries each one via the
 * same retryXxxSend() the manual /retry-send endpoints use.
 *
 * No queue system (BullMQ/Redis) on purpose: at the volume this replaces a
 * manual click with a periodic sweep — CONTINGENCY events are meant to be
 * rare (a DIAN outage, not routine traffic), so a fixed-interval full sweep
 * is proportionate. One document's failure never stops the sweep for the
 * rest — each retry is isolated in its own try/catch.
 */
export async function retryAllContingencyDocuments(
  logger?: FastifyBaseLogger,
  deps: DocumentServiceDeps = {},
): Promise<ContingencyRetrySummary> {
  const summary: ContingencyRetrySummary = { attempted: 0, accepted: 0, stillContingency: 0, failed: 0 };

  const [invoices, creditNotes, debitNotes, supportDocuments] = await Promise.all([
    prisma.invoice.findMany({ where: { status: "CONTINGENCY" }, select: { id: true, companyId: true } }),
    prisma.creditNote.findMany({ where: { status: "CONTINGENCY" }, select: { id: true, companyId: true } }),
    prisma.debitNote.findMany({ where: { status: "CONTINGENCY" }, select: { id: true, companyId: true } }),
    prisma.supportDocument.findMany({ where: { status: "CONTINGENCY" }, select: { id: true, companyId: true } }),
  ]);

  for (const invoice of invoices) {
    summary.attempted += 1;
    try {
      const result = await retryInvoiceSend(invoice.companyId, invoice.id, undefined, deps);
      tally(summary, result.status);
    } catch (error) {
      summary.failed += 1;
      logger?.warn({ error, invoiceId: invoice.id }, "contingency retry failed for invoice");
    }
  }

  for (const creditNote of creditNotes) {
    summary.attempted += 1;
    try {
      const result = await retryCreditNoteSend(creditNote.companyId, creditNote.id, undefined, deps);
      tally(summary, result.status);
    } catch (error) {
      summary.failed += 1;
      logger?.warn({ error, creditNoteId: creditNote.id }, "contingency retry failed for credit note");
    }
  }

  for (const debitNote of debitNotes) {
    summary.attempted += 1;
    try {
      const result = await retryDebitNoteSend(debitNote.companyId, debitNote.id, undefined, deps);
      tally(summary, result.status);
    } catch (error) {
      summary.failed += 1;
      logger?.warn({ error, debitNoteId: debitNote.id }, "contingency retry failed for debit note");
    }
  }

  for (const supportDocument of supportDocuments) {
    summary.attempted += 1;
    try {
      const result = await retrySupportDocumentSend(supportDocument.companyId, supportDocument.id, undefined, deps);
      tally(summary, result.status);
    } catch (error) {
      summary.failed += 1;
      logger?.warn({ error, supportDocumentId: supportDocument.id }, "contingency retry failed for support document");
    }
  }

  return summary;
}

function tally(summary: ContingencyRetrySummary, status: string): void {
  if (status === "CONTINGENCY") {
    summary.stillContingency += 1;
  } else {
    // ACCEPTED or REJECTED — either way DIAN responded, the sweep's job is done for this document.
    summary.accepted += 1;
  }
}

/** Registers the periodic sweep. No-op when START_SCHEDULER=false (see env.ts) — e.g. for tests or one-off scripts. */
export function startContingencyRetryScheduler(logger?: FastifyBaseLogger): void {
  if (!env.startScheduler) {
    logger?.info("Contingency retry scheduler disabled (START_SCHEDULER=false)");
    return;
  }

  cron.schedule(env.contingencyRetryCron, () => {
    retryAllContingencyDocuments(logger).then((summary) => {
      if (summary.attempted > 0) {
        logger?.info({ summary }, "contingency retry sweep completed");
      }
    }).catch((error) => {
      logger?.error({ error }, "contingency retry sweep crashed");
    });
  });

  logger?.info({ cron: env.contingencyRetryCron }, "contingency retry scheduler started");
}
