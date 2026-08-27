import { randomBytes } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import cron from "node-cron";
import forge from "node-forge";

import { prisma } from "../infrastructure/prisma.js";
import { FirmaPassClient } from "../providers/firmapass/FirmaPassClient.js";
import { createDefaultCertificateSecretStore } from "../shared/certificateStore.js";
import { env } from "../shared/env.js";

export interface FirmaPassIssuanceSummary {
  checked: number;
  finalized: number;
  stillPending: number;
  failed: number;
}

/** FirmaPass certificate states that mean issuance failed/won't ever produce a usable certificate. */
const TERMINAL_FAILURE_STATES = new Set(["r", "d"]);

function buildPkcs12(privateKeyPem: string, certificatePem: string, password: string): Buffer {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const certificate = forge.pki.certificateFromPem(certificatePem);
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary");
}

/**
 * Sweeps every FirmaPass Certificate row still awaiting real issuance
 * (status INACTIVE, expiresAt null — see firmaPassIssuance.service.ts) and
 * checks FirmaPass's own /api/certificados/{id} for each. A certificate
 * confirmed via FirmaPass only reaches estado "v" (vigente) sometime after
 * `confirmar` — there is no webhook, polling is the only way to learn this.
 *
 * Same shape as contingencyRetry.job.ts: one isolated try/catch per row, a
 * summary tally, no queue system (this is a rare, not-high-frequency event).
 */
export async function finalizePendingFirmaPassCertificates(
  logger?: FastifyBaseLogger,
): Promise<FirmaPassIssuanceSummary> {
  const summary: FirmaPassIssuanceSummary = { checked: 0, finalized: 0, stillPending: 0, failed: 0 };

  const pending = await prisma.certificate.findMany({
    where: { provider: "firmapass", status: "INACTIVE", expiresAt: null },
  });

  const secretStore = createDefaultCertificateSecretStore();

  for (const row of pending) {
    summary.checked += 1;
    try {
      if (!env.firmaPassAllianceLoginKey) {
        throw new Error("FIRMAPASS_ALLIANCE_LOGIN_KEY is not configured");
      }
      const client = new FirmaPassClient(env.firmaPassAllianceLoginKey);
      const { data: detail } = await client.getCertificate(row.certificateIdentifier);

      if (detail.estado === "v" && detail.public_certificate_pem) {
        const secret = await secretStore.get(row.secretReference);
        const privateKeyPem = secret.p12.toString("utf-8");
        const password = randomBytes(24).toString("base64url");
        const p12 = buildPkcs12(privateKeyPem, detail.public_certificate_pem, password);

        await secretStore.save(row.secretReference, { p12, password });
        await prisma.certificate.update({
          where: { id: row.id },
          data: {
            status: "ACTIVE",
            expiresAt: detail.expires_at ? new Date(detail.expires_at) : null,
          },
        });
        summary.finalized += 1;
      } else if (TERMINAL_FAILURE_STATES.has(detail.estado)) {
        await secretStore.delete(row.secretReference);
        await prisma.certificate.delete({ where: { id: row.id } });
        summary.failed += 1;
        logger?.warn(
          { certificateId: row.id, estado: detail.estado },
          "FirmaPass certificate reached a terminal failure state — discarded",
        );
      } else {
        summary.stillPending += 1;
      }
    } catch (error) {
      summary.failed += 1;
      logger?.warn({ error, certificateId: row.id }, "FirmaPass issuance check failed for certificate");
    }
  }

  return summary;
}

/** Registers the periodic sweep. No-op when START_SCHEDULER=false (see env.ts) — e.g. for tests or one-off scripts. */
export function startFirmaPassIssuanceScheduler(logger?: FastifyBaseLogger): void {
  if (!env.startScheduler) {
    logger?.info("FirmaPass issuance scheduler disabled (START_SCHEDULER=false)");
    return;
  }

  cron.schedule(env.firmaPassIssuanceCron, () => {
    finalizePendingFirmaPassCertificates(logger)
      .then((summary) => {
        if (summary.checked > 0) {
          logger?.info({ summary }, "FirmaPass issuance sweep completed");
        }
      })
      .catch((error) => {
        logger?.error({ error }, "FirmaPass issuance sweep crashed");
      });
  });

  logger?.info({ cron: env.firmaPassIssuanceCron }, "FirmaPass issuance scheduler started");
}
