import type { FastifyBaseLogger } from "fastify";

import { prisma } from "../infrastructure/prisma.js";
import type { DocumentXmlStore } from "../providers/documents/DocumentXmlStore.js";
import { createDefaultDocumentXmlStore } from "./documentXmlStore.js";

export interface ProcessingReconcileSummary {
  invoices: number;
  creditNotes: number;
  debitNotes: number;
  supportDocuments: number;
  payrollDocuments: number;
  payrollAdjustments: number;
}

// A request in flight never takes this long (DIAN calls time out well
// before) - a PROCESSING row older than this has no process working it.
const ORPHAN_AFTER_MS = 10 * 60 * 1000;

const UNSENT_MESSAGE =
  "El servidor se reinició antes de firmar o enviar este documento a la DIAN - no salió. Puedes reintentarlo con la misma referencia.";
const RECOVERED_MESSAGE =
  "El servidor se reinició mientras se enviaba este documento; se recuperó el XML firmado y se reenviará automáticamente a la DIAN (mismo número y CUFE).";
const UNREADABLE_MESSAGE =
  "El servidor se reinició mientras se enviaba este documento y no se pudo leer su XML firmado - verifica en la DIAN si llegó antes de volver a emitirlo.";

/**
 * Whether the signed XML of a document was stored. createXxx saves it under
 * the row id right BEFORE sending to DIAN, so "absent" proves the document
 * never left; "unknown" (the store itself failed) proves nothing.
 */
export async function documentXmlState(xmlStore: DocumentXmlStore, reference: string): Promise<{ state: "present"; xml: string } | { state: "absent" | "unknown" }> {
  try {
    return { state: "present", xml: await xmlStore.get(reference) };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    return code === "ENOENT" || code === "P2025" ? { state: "absent" } : { state: "unknown" };
  }
}

const firstText = (xml: string, pattern: RegExp): string | null => pattern.exec(xml)?.[1]?.trim() || null;

/**
 * Number + CUFE/CUNE exactly as they were signed - what retryXxxSend needs to
 * resend the SAME document (dian-kit's documentNumber is the document's own
 * id element; uuid is its cbc:UUID / CUNE).
 */
export function extractSignedIdentifiers(xml: string, kind: "ubl" | "payroll"): { number: string; uuid: string } | null {
  const number =
    kind === "payroll"
      ? firstText(xml, /<(?:\w+:)?Consecutivo>([^<]+)<\/(?:\w+:)?Consecutivo>/)
      : // The document's own cbc:ID follows ProfileExecutionID; a credit
        // note's BillingReference cbc:ID (the referenced invoice) comes later.
        firstText(xml, /<\/cbc:ProfileExecutionID>\s*<cbc:ID[^>]*>([^<]+)<\/cbc:ID>/) ?? firstText(xml, /<cbc:ID[^>]*>([^<]+)<\/cbc:ID>/);
  const uuid = kind === "payroll" ? firstText(xml, /<(?:\w+:)?CUNE>([^<]+)<\/(?:\w+:)?CUNE>/) : firstText(xml, /<cbc:UUID[^>]*>([^<]+)<\/cbc:UUID>/);
  return number && uuid ? { number, uuid } : null;
}

/**
 * A replayed create (same internalReference) of a document that ended in
 * ERROR without ever being signed - nothing reached DIAN. createXxx used to
 * hand that ERROR back forever, and Ohnix always re-sends an invoice under
 * the same reference (its invoice number), so the invoice could never be
 * issued again. The failed row is kept (renamed) as history and the caller
 * issues fresh. Returns false when it must be returned as-is instead.
 */
export async function releaseUnsentErrorDocument(
  existing: { id: string; status: string; internalReference: string; xmlReference: string | null; cufe?: string | null; cune?: string | null },
  xmlStore: DocumentXmlStore,
  rename: (internalReference: string) => Promise<unknown>,
): Promise<boolean> {
  if (existing.status !== "ERROR" || existing.xmlReference || existing.cufe || existing.cune) return false;
  if ((await documentXmlState(xmlStore, existing.id)).state !== "absent") return false;
  await rename(`${existing.internalReference}~failed-${Date.now().toString(36)}`);
  return true;
}

type OrphanRow = { id: string; numberingId: string | null };

async function recoverOrphans(
  rows: OrphanRow[],
  kind: "ubl" | "payroll",
  xmlStore: DocumentXmlStore,
  write: (id: string, data: Record<string, unknown>) => Promise<{ count: number }>,
  fields: { number: string; uuid: string },
): Promise<number> {
  let recovered = 0;
  for (const row of rows) {
    const xml = await documentXmlState(xmlStore, row.id);
    if (xml.state === "unknown") continue; // storage hiccup - next sweep decides
    let data: Record<string, unknown>;
    if (xml.state !== "present") {
      data = { status: "ERROR", errorMessage: UNSENT_MESSAGE };
    } else {
      const ids = extractSignedIdentifiers(xml.xml, kind);
      const numbering = row.numberingId ? await prisma.numberingResolution.findUnique({ where: { id: row.numberingId }, select: { prefix: true } }) : null;
      data = ids
        ? {
            // CONTINGENCY = "signed, may or may not have reached DIAN": the
            // contingency sweep resends this exact XML - DIAN treats a CUFE
            // it already has as the same document, never a second one.
            status: "CONTINGENCY",
            xmlReference: row.id,
            [fields.number]: ids.number,
            [fields.uuid]: ids.uuid,
            prefix: numbering?.prefix ?? null,
            issuedAt: new Date(),
            errorMessage: RECOVERED_MESSAGE,
          }
        : { status: "ERROR", xmlReference: row.id, errorMessage: UNREADABLE_MESSAGE };
    }
    // Guarded: a slow-but-alive request that finished meanwhile wins.
    recovered += (await write(row.id, data)).count;
  }
  return recovered;
}

/**
 * Recovers documents orphaned while PROCESSING (a deploy or crash killed the
 * request mid-way). This used to run once at startup and fail EVERY
 * PROCESSING row - including documents the previous instance, still alive
 * during the deploy, was sending at that moment - and its "retry with a new
 * internalReference" advice was impossible for invoices, which Ohnix always
 * sends under their invoice number. Now: only rows idle for ORPHAN_AFTER_MS,
 * every contingency sweep (see contingencyRetry.job.ts) plus once at startup,
 * and decided by how far the document got:
 *  - signed XML stored -> CONTINGENCY with that exact number/CUFE, resent by
 *    the contingency sweep;
 *  - nothing stored -> ERROR, which a replay of the same internalReference
 *    now issues afresh (releaseUnsentErrorDocument).
 */
export async function reconcileOrphanedProcessingDocuments(
  logger?: FastifyBaseLogger,
  { xmlStore = createDefaultDocumentXmlStore(), olderThanMs = ORPHAN_AFTER_MS }: { xmlStore?: DocumentXmlStore; olderThanMs?: number } = {},
): Promise<ProcessingReconcileSummary> {
  const where = { status: "PROCESSING" as const, updatedAt: { lt: new Date(Date.now() - olderThanMs) } };
  const select = { id: true, numberingId: true };
  const guard = (id: string) => ({ id, status: "PROCESSING" as const });
  const ubl = { number: "documentNumber", uuid: "cufe" };

  const summary: ProcessingReconcileSummary = {
    invoices: await recoverOrphans(await prisma.invoice.findMany({ where, select }), "ubl", xmlStore, (id, data) => prisma.invoice.updateMany({ where: guard(id), data }), { number: "invoiceNumber", uuid: "cufe" }),
    creditNotes: await recoverOrphans(await prisma.creditNote.findMany({ where, select }), "ubl", xmlStore, (id, data) => prisma.creditNote.updateMany({ where: guard(id), data }), { number: "noteNumber", uuid: "cufe" }),
    debitNotes: await recoverOrphans(await prisma.debitNote.findMany({ where, select }), "ubl", xmlStore, (id, data) => prisma.debitNote.updateMany({ where: guard(id), data }), { number: "noteNumber", uuid: "cufe" }),
    supportDocuments: await recoverOrphans(await prisma.supportDocument.findMany({ where, select }), "ubl", xmlStore, (id, data) => prisma.supportDocument.updateMany({ where: guard(id), data }), ubl),
    payrollDocuments: await recoverOrphans(await prisma.payrollDocument.findMany({ where, select }), "payroll", xmlStore, (id, data) => prisma.payrollDocument.updateMany({ where: guard(id), data }), { number: "documentNumber", uuid: "cune" }),
    payrollAdjustments: await recoverOrphans(await prisma.payrollAdjustment.findMany({ where, select }), "payroll", xmlStore, (id, data) => prisma.payrollAdjustment.updateMany({ where: guard(id), data }), { number: "documentNumber", uuid: "cune" }),
  };
  const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
  if (total > 0) {
    logger?.warn({ summary }, `Recovered ${total} document(s) orphaned in PROCESSING`);
  }
  return summary;
}
