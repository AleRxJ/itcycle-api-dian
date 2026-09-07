import type { CertificateProvider } from "./CertificateProvider.js";

export type CertificateProviderName = "viafirma" | "firmapass";

/**
 * Thrown by a provider's network layer for a TRANSPORT/INFRASTRUCTURE
 * failure only (timeout, connection refused, HTTP 5xx, "service
 * unavailable") — never for the provider correctly reporting a rejected
 * application (wrong identity, invalid RUES/NIT, rejected documents). Those
 * surface as an {@link InternalCertificateStatus} via `getStatus`, not as a
 * thrown error — see `isFunctionalRejection` in `./CertificateProvider.ts`.
 *
 * This distinction is what lets {@link CertificateProviderRegistry} apply
 * the product brief's fallback rule correctly: "Estos [technical errors]
 * pueden permitir fallback ... Estos [functional errors] NO deben activar
 * automáticamente FirmaPass". Fase 3's real Viafirma/FirmaPass HTTP clients
 * MUST throw this (not a bare Error) for network/5xx failures for the rule
 * to have anything to key off.
 */
export class CertificateProviderTechnicalError extends Error {
  constructor(
    message: string,
    public readonly provider: CertificateProviderName,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CertificateProviderTechnicalError";
  }
}

export interface CertificateProviderRegistryConfig {
  primary: CertificateProviderName;
  /** null disables fallback entirely, regardless of fallbackEnabled. */
  fallback: CertificateProviderName | null;
  fallbackEnabled: boolean;
  /** Independent of `primary`/`fallback` choice — lets Viafirma be wired but dark (see VIAFIRMA_ENABLED in env.ts) while the integration is still being validated in Sandbox. */
  viafirmaEnabled: boolean;
}

/**
 * Holds both provider instances and the primary/fallback policy from
 * config (see `PRIMARY_PROVIDER`/`FALLBACK_PROVIDER`/`FALLBACK_ENABLED`/
 * `VIAFIRMA_ENABLED` in `../../shared/env.ts`).
 *
 * Deliberately does NOT own "start a new certificate issuance" — that
 * requires checking the company's EXISTING `Certificate` rows first (per
 * the brief: "Si Viafirma ya creó una solicitud, NO crear automáticamente
 * otra en FirmaPass ... Evitar certificados duplicados"), which means
 * Prisma access and belongs in a higher orchestration service
 * (`CertificateService`, not yet built — REQUIERE_CONFIRMACION_VIAFIRMA:
 * this needs its own design pass once Fase 3/4 land real issuance calls;
 * it is intentionally out of scope for this Fase 2 skeleton). This
 * registry only answers the two questions that don't need that state:
 * "which provider should a brand-new applicant be routed to" and "given a
 * technical failure, is a fallback provider even configured/allowed".
 */
export class CertificateProviderRegistry {
  constructor(
    private readonly providers: Partial<Record<CertificateProviderName, CertificateProvider>>,
    private readonly config: CertificateProviderRegistryConfig,
  ) {}

  get(name: CertificateProviderName): CertificateProvider {
    const provider = this.providers[name];
    if (!provider) {
      throw new Error(`CertificateProvider "${name}" is not registered`);
    }
    return provider;
  }

  /**
   * Which provider a brand-new applicant (no existing request yet) should
   * be routed to. Falls back to `fallback` only when `primary` is
   * "viafirma" but `viafirmaEnabled` is false — i.e. the progressive
   * rollout switch (`VIAFIRMA_ENABLED=false` initially, per the brief's
   * feature-flag section), NOT a runtime-failure fallback.
   */
  choosePrimaryForNewRequest(): CertificateProviderName {
    if (this.config.primary === "viafirma" && !this.config.viafirmaEnabled) {
      if (!this.config.fallback) {
        throw new Error(
          "PRIMARY_PROVIDER=viafirma but VIAFIRMA_ENABLED=false and no FALLBACK_PROVIDER is configured — " +
            "no certificate provider is usable.",
        );
      }
      return this.config.fallback;
    }
    return this.config.primary;
  }

  /**
   * Whether a {@link CertificateProviderTechnicalError} raised by
   * `failedProvider` while starting a brand-new request (no prior request
   * for this applicant on ANY provider yet) may be retried against the
   * configured fallback. Returns null when fallback isn't applicable
   * (disabled, unconfigured, or would just retry the same provider);
   * otherwise the provider name to retry against.
   *
   * Callers with an EXISTING request already in flight must NOT call this
   * to decide whether to start a second, parallel request — see the class
   * doc comment. This is only for the very first attempt.
   */
  fallbackForNewRequestFailure(
    failedProvider: CertificateProviderName,
    error: unknown,
  ): CertificateProviderName | null {
    if (!(error instanceof CertificateProviderTechnicalError)) return null;
    if (!this.config.fallbackEnabled) return null;
    if (!this.config.fallback || this.config.fallback === failedProvider) return null;
    return this.config.fallback;
  }
}
