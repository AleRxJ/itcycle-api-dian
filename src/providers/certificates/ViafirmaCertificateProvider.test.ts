import forge from "node-forge";
import { describe, expect, it } from "vitest";

import { assemblePkcs12FromP7b, generateKeyPairAndCsr, mapViafirmaStatus } from "./ViafirmaCertificateProvider.js";
import { isFunctionalRejection } from "./CertificateProvider.js";

/**
 * Stands in for what `ViafirmaApiClient.downloadP7b` returns: a real,
 * DER-encoded PKCS#7 "certs-only" bundle (no signers, no content — exactly
 * what a .p7b file is) containing a leaf certificate for `leafPublicKey`
 * signed by a throwaway CA, plus that CA's own certificate — mirroring a
 * P7B that includes the issuing chain, not just the end-entity cert.
 */
function buildFakeP7b(leafPublicKey: forge.pki.rsa.PublicKey, leafAttrs: { name: string; value: string }[]): Buffer {
  const caKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const caAttrs = [{ name: "commonName", value: "Test CA" }, { name: "countryName", value: "CO" }];

  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafPublicKey;
  leafCert.serialNumber = "02";
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  leafCert.setSubject(leafAttrs);
  leafCert.setIssuer(caAttrs);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const p7 = forge.pkcs7.createSignedData();
  // Order deliberately CA-first, leaf-second — assemblePkcs12FromP7b must
  // find the leaf by key match, never by assuming array position.
  p7.addCertificate(caCert);
  p7.addCertificate(leafCert);

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, "binary");
}

const PJ_SUBJECT = {
  profileKind: "FE-PJ" as const,
  country: "CO",
  state: "ANTIOQUIA",
  locality: "MEDELLIN",
  address: "Carrera 65 #3",
  organization: "MI COMPANIA",
  organizationalUnit: "FACTURACION",
  nit: "900400300",
  email: "info@mail.com",
  givenName: "Paula",
  surname: "Ibarra",
};

const PN_SUBJECT = {
  profileKind: "FE-PN" as const,
  country: "CO",
  state: "ANTIOQUIA",
  locality: "MEDELLIN",
  address: "Carrera 65 #3",
  identity: "1002000400",
  email: "info@mail.com",
  givenName: "Paula",
  surname: "Ibarra",
};

// §3.1/§3.2 of the API doc: exactly these attributes, no CN (Viafirma
// synthesizes it server-side from the profile's dnPattern — see §2.3.1).
describe("generateKeyPairAndCsr", () => {
  it("builds a self-verifying FE-PJ CSR with exactly the 10 documented attributes", () => {
    const { csrPem, privateKeyPem } = generateKeyPairAndCsr(PJ_SUBJECT);
    expect(csrPem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
    expect(privateKeyPem).toMatch(/PRIVATE KEY-----/);

    const csr = forge.pki.certificationRequestFromPem(csrPem);
    expect(csr.verify()).toBe(true);

    const byName = (name: string) => csr.subject.getField({ name })?.value;
    expect(byName("countryName")).toBe("CO");
    expect(byName("stateOrProvinceName")).toBe("ANTIOQUIA");
    expect(byName("localityName")).toBe("MEDELLIN");
    expect(byName("streetAddress")).toBe("Carrera 65 #3");
    expect(byName("organizationName")).toBe("MI COMPANIA");
    expect(byName("organizationalUnitName")).toBe("FACTURACION");
    expect(byName("serialNumber")).toBe("900400300");
    expect(byName("emailAddress")).toBe("info@mail.com");
    expect(byName("givenName")).toBe("Paula");
    expect(byName("surname")).toBe("Ibarra");
    expect(csr.subject.attributes).toHaveLength(10);
  });

  it("builds a self-verifying FE-PN CSR with exactly the 9 documented attributes (no O/OU)", () => {
    const { csrPem } = generateKeyPairAndCsr(PN_SUBJECT);
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    expect(csr.verify()).toBe(true);
    expect(csr.subject.getField({ name: "serialNumber" })?.value).toBe("1002000400");
    expect(csr.subject.getField({ name: "organizationName" })).toBeNull();
    expect(csr.subject.attributes).toHaveLength(8);
  });

  it("never puts the private key inside the CSR itself", () => {
    const { csrPem, privateKeyPem } = generateKeyPairAndCsr(PJ_SUBJECT);
    // Cheap but meaningful smoke check: the private key material must not
    // leak into what eventually gets sent to Viafirma as `csr`.
    const privateKeyBody = privateKeyPem.replace(/-----[^-]+-----/g, "").trim();
    expect(csrPem.includes(privateKeyBody.slice(0, 40))).toBe(false);
  });

  it("rejects a missing required field instead of silently building an incomplete CSR", () => {
    expect(() => generateKeyPairAndCsr({ ...PN_SUBJECT, state: "" })).toThrow(/missing required subject field/);
  });

  it("rejects a missing FE-PJ-only field (organization)", () => {
    expect(() => generateKeyPairAndCsr({ ...PJ_SUBJECT, organization: "  " })).toThrow(/organization/);
  });
});

describe("assemblePkcs12FromP7b", () => {
  it("finds the leaf certificate by key match (not array position) and builds a working PKCS12", () => {
    const { privateKeyPem } = generateKeyPairAndCsr(PJ_SUBJECT);
    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem) as forge.pki.rsa.PrivateKey;
    const publicKey = forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e);

    const p7b = buildFakeP7b(publicKey, [
      { name: "commonName", value: "MI COMPANIA - ANTIOQUIA" },
      { name: "serialNumber", value: "900400300" },
    ]);

    const { p12, password } = assemblePkcs12FromP7b(p7b, privateKeyPem);
    expect(password).toHaveLength(32); // randomBytes(24).toString("base64url")

    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString("binary")));
    const p12Parsed = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
    const keyBags = p12Parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const certBags = p12Parsed.getBags({ bagType: forge.pki.oids.certBag });

    const recoveredKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key as forge.pki.rsa.PrivateKey;
    expect(recoveredKey.n.equals(privateKey.n)).toBe(true);

    // Both the leaf (matches our key) and the throwaway CA cert must survive into the PKCS12.
    const certs = certBags[forge.pki.oids.certBag] ?? [];
    expect(certs).toHaveLength(2);
    const leafBag = certs.find((bag) => (bag.cert!.publicKey as forge.pki.rsa.PublicKey).n.equals(privateKey.n));
    expect(leafBag?.cert?.subject.getField({ name: "serialNumber" })?.value).toBe("900400300");
  });

  it("throws instead of silently picking a non-matching certificate", () => {
    const { privateKeyPem } = generateKeyPairAndCsr(PJ_SUBJECT);
    const unrelatedKeys = forge.pki.rsa.generateKeyPair({ bits: 2048 });

    const p7b = buildFakeP7b(unrelatedKeys.publicKey, [{ name: "commonName", value: "Someone Else" }]);

    expect(() => assemblePkcs12FromP7b(p7b, privateKeyPem)).toThrow(/none of the certificates/);
  });

  it("throws on an empty certs-only bundle", () => {
    const { privateKeyPem } = generateKeyPairAndCsr(PJ_SUBJECT);
    const p7 = forge.pkcs7.createSignedData();
    const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    expect(() => assemblePkcs12FromP7b(Buffer.from(der, "binary"), privateKeyPem)).toThrow(/no certificates/);
  });
});

// Exhaustive against every code documented in "Uso del API para perfiles
// PKCS#10 v1.7" §2.3.4.1 (happy path) and §2.3.4.2 (error states).
describe("mapViafirmaStatus", () => {
  it.each([
    ["rues_check", "pending_provider_review"],
    ["proposeFor", "pending_provider_review"],
    ["proposedToAcceptance", "pending_provider_review"],
    ["All_Ok", "pending_provider_review"],
    ["inProcess", "pending_provider_review"],
    ["signedContract", "pending_provider_review"],
    ["Cite_To_Finish", "pending_provider_review"],
    ["processingContract", "pending_provider_review"],
    ["accreditation", "awaiting_identity_verification"],
    ["accreditation_check", "verifying_identity"],
    ["accreditation_completed", "verifying_identity"],
    ["accreditation_verified", "verifying_identity"],
    ["collate_data", "verifying_identity"],
    ["accreditation_rejected", "identity_rejected"],
    ["docRequired", "awaiting_documents"],
    ["docUploaded", "pending_provider_review"],
    ["checking", "pending_provider_review"],
    ["rues_error", "issuance_failed"],
    ["fail", "issuance_failed"],
    ["Generated_Not_Downloaded", "issued_ready_to_finalize"],
    ["Generated_And_Downloaded", "active"],
  ])("maps %s -> %s", (code, expected) => {
    expect(mapViafirmaStatus(code)).toBe(expected);
  });

  it("treats an undocumented code conservatively as issuance_failed rather than silently waiting forever", () => {
    expect(mapViafirmaStatus("some_future_code_not_in_the_doc")).toBe("issuance_failed");
  });

  it("treats every per-request rejection/failure as a functional rejection that must block fallback", () => {
    // Brief's own examples: "Viafirma rechaza identidad -> NO FirmaPass",
    // "Viafirma rechaza RUES -> NO FirmaPass".
    expect(isFunctionalRejection(mapViafirmaStatus("accreditation_rejected"))).toBe(true);
    expect(isFunctionalRejection(mapViafirmaStatus("rues_error"))).toBe(true);
    expect(isFunctionalRejection(mapViafirmaStatus("fail"))).toBe(true);
  });

  it("never treats an in-progress or successful status as a functional rejection", () => {
    expect(isFunctionalRejection(mapViafirmaStatus("rues_check"))).toBe(false);
    expect(isFunctionalRejection(mapViafirmaStatus("accreditation"))).toBe(false);
    expect(isFunctionalRejection(mapViafirmaStatus("Generated_And_Downloaded"))).toBe(false);
  });
});
