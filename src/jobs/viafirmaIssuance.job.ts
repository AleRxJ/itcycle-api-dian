import type { FastifyBaseLogger } from "fastify";
import cron from "node-cron";

import { prisma } from "../infrastructure/prisma.js";
import {
  assemblePkcs12FromP7b,
  mapViafirmaStatus,
  ViafirmaCertificateProvider,
} from "../providers/certificates/ViafirmaCertificateProvider.js";
import { createDefaultCertificateSecretStore } from "../shared/certificateStore.js";
import { env } from "../shared/env.js";

export interface ViafirmaIssuanceSummary {
  checked: number;
  finalized: number;
  stillPending: number;
  failed: number;
}

function getProvider(): ViafirmaCertificateProvider {
  if (!env.viafirmaConsumerKey || !env.viafirmaConsumerSecret) {
    throw new Error("VIAFIRMA_CONSUMER_KEY / VIAFIRMA_CONSUMER_SECRET are not configured");
  }
  return new ViafirmaCertificateProvider({
    baseUrl: env.viafirmaBaseUrl,
    downloadBaseUrl: env.viafirmaDownloadBaseUrl ?? "",
    consumerKey: env.viafirmaConsumerKey,
    consumerSecret: env.viafirmaConsumerSecret,
    ra: env.viafirmaRa,
  });
}

/**
 * Sweeps every Viafirma `Certificate` row still awaiting real issuance
 * (status INACTIVE, expiresAt null — see `../modules/viafirma/viafirmaIssuance.service.ts`)
 * and checks Viafirma's own `/request/{codRequest}/status` for each. Same
 * shape as `./firmaPassIssuance.job.ts`'s `finalizePendingFirmaPassCertificates`
 * (one isolated try/catch per row, a summary tally, no queue system — this
 * is a low-frequency event) even though the finalization step itself is
 * necessarily different: Viafirma's P7B needs `assemblePkcs12FromP7b`
 * (possibly multiple certificates in the bundle), where FirmaPass hands
 * back one bare certificate PEM.
 */
export async function finalizePendingViafirmaCertificates(logger?: FastifyBaseLogger): Promise<ViafirmaIssuanceSummary> {
  const summary: ViafirmaIssuanceSummary = { checked: 0, finalized: 0, stillPending: 0, failed: 0 };

  const pending = await prisma.certificate.findMany({
    where: { provider: "viafirma", status: "INACTIVE", expiresAt: null },
  });

  const provider = getProvider();
  const secretStore = createDefaultCertificateSecretStore();

  for (const row of pending) {
    summary.checked += 1;
    try {
      const rawStatus = await provider.getRequestStatus(row.certificateIdentifier);
      const internalStatus = mapViafirmaStatus(rawStatus);

      if (internalStatus === "issued_ready_to_finalize") {
        const publicId = (row.providerMetadata as { publicId?: string } | null)?.publicId;
        if (!publicId) {
          throw new Error(`Certificate ${row.id} reached ${rawStatus} but has no publicId in providerMetadata`);
        }

        const secret = await secretStore.get(row.secretReference);
        const privateKeyPem = secret.p12.toString("utf-8");
        const p7b = await provider.downloadP7b(publicId);
        const { p12, password, expiresAt } = assemblePkcs12FromP7b(p7b, privateKeyPem);

        await secretStore.save(row.secretReference, { p12, password });
        await prisma.certificate.update({
          where: { id: row.id },
          data: { status: "ACTIVE", expiresAt },
        });
        summary.finalized += 1;
      } else if (
        internalStatus === "identity_rejected" ||
        internalStatus === "issuance_failed" ||
        internalStatus === "rues_verification_failed"
      ) {
        await secretStore.delete(row.secretReference);
        await prisma.certificate.delete({ where: { id: row.id } });
        summary.failed += 1;
        logger?.warn(
          { certificateId: row.id, rawStatus },
          "Viafirma certificate reached a terminal failure state — discarded",
        );
      } else {
        // pending_provider_review / awaiting_identity_verification /
        // verifying_identity / awaiting_documents — nothing to do here;
        // awaiting_documents is surfaced to the user via
        // viafirmaIssuance.service.ts's uploadViafirmaDocument, not this sweep.
        summary.stillPending += 1;
      }
    } catch (error) {
      summary.failed += 1;
      logger?.warn({ error, certificateId: row.id }, "Viafirma issuance check failed for certificate");
    }
  }

  return summary;
}

/** Registers the periodic sweep. No-op when START_SCHEDULER=false or VIAFIRMA_ENABLED=false. */
export function startViafirmaIssuanceScheduler(logger?: FastifyBaseLogger): void {
  if (!env.startScheduler) {
    logger?.info("Viafirma issuance scheduler disabled (START_SCHEDULER=false)");
    return;
  }
  if (!env.viafirmaEnabled) {
    logger?.info("Viafirma issuance scheduler disabled (VIAFIRMA_ENABLED=false)");
    return;
  }

  cron.schedule(env.viafirmaIssuanceCron, () => {
    finalizePendingViafirmaCertificates(logger)
      .then((summary) => {
        if (summary.checked > 0) {
          logger?.info({ summary }, "Viafirma issuance sweep completed");
        }
      })
      .catch((error) => {
        logger?.error({ error }, "Viafirma issuance sweep crashed");
      });
  });

  logger?.info({ cron: env.viafirmaIssuanceCron }, "Viafirma issuance scheduler started");
}
