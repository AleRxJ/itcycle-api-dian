import { FirmaPassClient } from "../firmapass/FirmaPassClient.js";
import { env } from "../../shared/env.js";
import type {
  CertificateProvider,
  CertificateProviderRevocationResult,
  CertificateProviderStatusResult,
  InternalCertificateStatus,
} from "./CertificateProvider.js";

/**
 * Adapter over the EXISTING FirmaPass integration
 * (`../firmapass/FirmaPassClient.ts`, `../../modules/firmapass/firmaPassIssuance.service.ts`,
 * `../../jobs/firmaPassIssuance.job.ts`). This class changes NO behavior —
 * it only gives the pre-existing FirmaPass flow a
 * {@link CertificateProvider}-shaped face so `CertificateProviderRegistry`
 * and any provider-agnostic status/dashboard code can address it uniformly
 * alongside Viafirma. The rich, FirmaPass-specific issuance steps
 * (uploadRut/uploadArchivo/confirmar, the alliance-UUID claiming rules in
 * `firmaPassProvisioning.service.js` on the Ohnix side) are untouched and
 * keep being called directly wherever they already are — this adapter does
 * NOT re-route them.
 *
 * `getStatus`/`revoke` are genuinely new surface (nothing in the existing
 * code exposed FirmaPass status through the CertificateProvider shape
 * before), but both are thin: `getStatus` calls the same
 * `FirmaPassClient.getCertificate` the issuance job already polls;
 * `revoke` is intentionally NOT implemented yet — the existing Postman
 * collection's "revoke with revocationCode" endpoint
 * (`POST /request/revoke/code/{revokingCode}`) is documented for VIAFIRMA,
 * not verified against FirmaPass's own API surface. Wiring FirmaPass
 * revocation is out of scope for the Viafirma integration work this file
 * was added for — REQUIERE_CONFIRMACION: confirm FirmaPass's actual
 * revocation endpoint (their Postman collection referenced in
 * `firmaPassIssuance.service.ts` does not document one) before implementing it.
 */
export class FirmaPassCertificateProvider implements CertificateProvider {
  readonly name = "firmapass";

  private client(): FirmaPassClient {
    if (!env.firmaPassAllianceLoginKey) {
      throw new Error("FIRMAPASS_ALLIANCE_LOGIN_KEY is not configured");
    }
    return new FirmaPassClient(env.firmaPassAllianceLoginKey, env.firmaPassBaseUrl);
  }

  async getStatus(providerRequestId: string): Promise<CertificateProviderStatusResult> {
    const { data: detail } = await this.client().getCertificate(providerRequestId);
    return {
      internalStatus: mapFirmaPassStatus(detail.estado),
      providerStatus: detail.estado,
      requiresUserAction: false,
      requiresSupportIntervention: detail.estado === "d",
      failureReason: detail.estado === "d" || detail.estado === "r" ? detail.estado_descripcion : undefined,
    };
  }

  async revoke(_providerRequestId: string, _reason?: string): Promise<CertificateProviderRevocationResult> {
    throw new Error(
      "FirmaPassCertificateProvider.revoke is not implemented — FirmaPass's revocation endpoint has not been " +
        "confirmed against their API documentation. REQUIERE_CONFIRMACION_VIAFIRMA-equivalent: ask FirmaPass for it.",
    );
  }
}

/**
 * FirmaPass `estado` codes, per `FirmaPassCertificateDetail.estado` in
 * `../firmapass/FirmaPassClient.ts`: "pe" en espera, "v" vigente,
 * "e" expirado, "r" revocado, "d" (denegado/discarded — see
 * `TERMINAL_FAILURE_STATES` in `../../jobs/firmaPassIssuance.job.ts`, which
 * treats "r" and "d" alike as terminal-failure-during-issuance and deletes
 * the pending row). Note "r" here can mean either "revoked before ever
 * reaching vigente" (issuance-time) or "revoked after being active" — this
 * mapping doesn't distinguish those, matching the existing job's behavior.
 */
export function mapFirmaPassStatus(estado: string): InternalCertificateStatus {
  switch (estado) {
    case "pe":
      return "pending_provider_review";
    case "v":
      return "active";
    case "e":
      return "expired";
    case "r":
      return "revoked";
    case "d":
      return "issuance_failed";
    default:
      return "pending_provider_review";
  }
}
