import { describe, expect, it } from "vitest";

import type { CertificateProvider } from "./CertificateProvider.js";
import { CertificateProviderRegistry, CertificateProviderTechnicalError } from "./CertificateProviderRegistry.js";

function fakeProvider(name: string): CertificateProvider {
  return {
    name,
    getStatus: async () => {
      throw new Error("not used in these tests");
    },
    revoke: async () => {
      throw new Error("not used in these tests");
    },
  };
}

describe("CertificateProviderRegistry.choosePrimaryForNewRequest", () => {
  it("routes to viafirma when it's primary and enabled", () => {
    const registry = new CertificateProviderRegistry(
      { viafirma: fakeProvider("viafirma"), firmapass: fakeProvider("firmapass") },
      { primary: "viafirma", fallback: "firmapass", fallbackEnabled: true, viafirmaEnabled: true },
    );
    expect(registry.choosePrimaryForNewRequest()).toBe("viafirma");
  });

  it("falls back to firmapass when viafirma is primary but the rollout switch is off", () => {
    const registry = new CertificateProviderRegistry(
      { viafirma: fakeProvider("viafirma"), firmapass: fakeProvider("firmapass") },
      { primary: "viafirma", fallback: "firmapass", fallbackEnabled: true, viafirmaEnabled: false },
    );
    expect(registry.choosePrimaryForNewRequest()).toBe("firmapass");
  });

  it("throws when viafirma is primary, disabled, and no fallback is configured", () => {
    const registry = new CertificateProviderRegistry(
      { viafirma: fakeProvider("viafirma") },
      { primary: "viafirma", fallback: null, fallbackEnabled: true, viafirmaEnabled: false },
    );
    expect(() => registry.choosePrimaryForNewRequest()).toThrow(/no certificate provider is usable/);
  });

  it("stays on firmapass when it's simply configured as primary", () => {
    const registry = new CertificateProviderRegistry(
      { firmapass: fakeProvider("firmapass") },
      { primary: "firmapass", fallback: null, fallbackEnabled: false, viafirmaEnabled: false },
    );
    expect(registry.choosePrimaryForNewRequest()).toBe("firmapass");
  });
});

describe("CertificateProviderRegistry.fallbackForNewRequestFailure", () => {
  const config = { primary: "viafirma" as const, fallback: "firmapass" as const, fallbackEnabled: true, viafirmaEnabled: true };
  const providers = { viafirma: fakeProvider("viafirma"), firmapass: fakeProvider("firmapass") };

  it("allows fallback on a technical error", () => {
    const registry = new CertificateProviderRegistry(providers, config);
    const error = new CertificateProviderTechnicalError("timeout", "viafirma");
    expect(registry.fallbackForNewRequestFailure("viafirma", error)).toBe("firmapass");
  });

  it("never allows fallback on a plain (functional-shaped) error", () => {
    const registry = new CertificateProviderRegistry(providers, config);
    const error = new Error("identity rejected");
    expect(registry.fallbackForNewRequestFailure("viafirma", error)).toBeNull();
  });

  it("respects fallbackEnabled=false even for a technical error", () => {
    const registry = new CertificateProviderRegistry(providers, { ...config, fallbackEnabled: false });
    const error = new CertificateProviderTechnicalError("timeout", "viafirma");
    expect(registry.fallbackForNewRequestFailure("viafirma", error)).toBeNull();
  });

  it("returns null when there is no fallback configured", () => {
    const registry = new CertificateProviderRegistry(providers, { ...config, fallback: null });
    const error = new CertificateProviderTechnicalError("timeout", "viafirma");
    expect(registry.fallbackForNewRequestFailure("viafirma", error)).toBeNull();
  });

  it("returns null when the fallback would just retry the same provider", () => {
    const registry = new CertificateProviderRegistry(providers, { ...config, fallback: "viafirma" });
    const error = new CertificateProviderTechnicalError("timeout", "viafirma");
    expect(registry.fallbackForNewRequestFailure("viafirma", error)).toBeNull();
  });
});
