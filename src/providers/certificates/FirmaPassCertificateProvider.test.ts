import { describe, expect, it } from "vitest";

import { mapFirmaPassStatus } from "./FirmaPassCertificateProvider.js";

// Per FirmaPassCertificateDetail.estado in ../firmapass/FirmaPassClient.ts.
describe("mapFirmaPassStatus", () => {
  it.each([
    ["pe", "pending_provider_review"],
    ["v", "active"],
    ["e", "expired"],
    ["r", "revoked"],
    ["d", "issuance_failed"],
  ])("maps %s -> %s", (estado, expected) => {
    expect(mapFirmaPassStatus(estado)).toBe(expected);
  });

  it("treats an unrecognized estado as pending rather than a silent failure", () => {
    expect(mapFirmaPassStatus("unknown_future_estado")).toBe("pending_provider_review");
  });
});
