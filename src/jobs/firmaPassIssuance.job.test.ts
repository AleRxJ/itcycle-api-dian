import { randomUUID } from "node:crypto";

import forge from "node-forge";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.FIRMAPASS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64url");

const getCertificateMock = vi.fn();

vi.mock("../providers/firmapass/FirmaPassClient.js", () => ({
  FirmaPassClient: vi.fn().mockImplementation(() => ({
    getCertificate: getCertificateMock,
  })),
}));

// A plain `process.env.X ??= ...` above doesn't reliably beat env.ts's own
// module-eval-time read (ESM hoists this file's imports - including the
// transitive import of env.js - ahead of its own top-level statements,
// regardless of source order) - vi.mock is the one mechanism guaranteed to
// run before env.js is evaluated.
vi.mock("../shared/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/env.js")>();
  return { ...actual, env: { ...actual.env, firmaPassAllianceLoginKey: "test-alliance-login-key" } };
});

import { prisma } from "../infrastructure/prisma.js";
import { createDefaultCertificateSecretStore } from "../shared/certificateStore.js";
import { finalizePendingFirmaPassCertificates } from "./firmaPassIssuance.job.js";

const TEST_NIT = "999000009";
const TEST_DV = "1";

function generateTestKeyAndCert(): { privateKeyPem: string; certificatePem: string } {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
  const attrs = [{ name: "commonName", value: "FirmaPass Job Test Cert" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
  };
}

interface MockCertResponse {
  estado: string;
  public_certificate_pem?: string | null;
  expires_at?: string;
}

// Keyed by certificateIdentifier rather than call order: findMany() sweeps
// EVERY pending firmapass Certificate row in the database, including rows
// left behind by other concurrently-running test files (same pattern/caveat
// as contingencyRetry.job.test.ts) — a call-order queue would silently wire
// the wrong response to the wrong row. Any identifier not in the map (e.g. a
// foreign row from another test file) defaults to "still pending", which is
// always harmless.
function mockCertificateResponses(responses: Record<string, MockCertResponse>): void {
  getCertificateMock.mockImplementation(async (identificador: string) => {
    const entry = responses[identificador] ?? { estado: "pe", public_certificate_pem: null };
    return {
      message: "ok",
      data: {
        estado: entry.estado,
        public_certificate_pem: entry.public_certificate_pem ?? null,
        expires_at: entry.expires_at ?? null,
      },
    };
  });
}

let companyId: string;
const secretStore = createDefaultCertificateSecretStore();

async function seedPendingCertificate(certificateIdentifier: string) {
  const { privateKeyPem } = generateTestKeyAndCert();
  const secretReference = randomUUID();
  await secretStore.save(secretReference, { p12: Buffer.from(privateKeyPem, "utf-8"), password: "" });
  return prisma.certificate.create({
    data: {
      companyId,
      provider: "firmapass",
      certificateIdentifier,
      secretReference,
      expiresAt: null,
      status: "INACTIVE",
    },
  });
}

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(async () => {
  await cleanup();
  const company = await prisma.company.create({
    data: { name: "FirmaPass Job Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("finalizePendingFirmaPassCertificates", () => {
  it("leaves a certificate still en espera (estado 'pe') untouched", async () => {
    const row = await seedPendingCertificate("job-test-pending");
    mockCertificateResponses({ "job-test-pending": { estado: "pe", public_certificate_pem: null } });

    await finalizePendingFirmaPassCertificates();

    const after = await prisma.certificate.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("INACTIVE");
    expect(after.expiresAt).toBeNull();
  });

  it("finalizes a certificate once estado is 'v': builds a real PKCS12 and flips status to ACTIVE", async () => {
    const row = await seedPendingCertificate("job-test-finalize");
    const { certificatePem } = generateTestKeyAndCert(); // a *different* keypair — only the cert PEM parseability matters here
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

    mockCertificateResponses({
      "job-test-finalize": { estado: "v", public_certificate_pem: certificatePem, expires_at: expiresAt },
    });

    await finalizePendingFirmaPassCertificates();

    const after = await prisma.certificate.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.expiresAt).not.toBeNull();

    const secret = await secretStore.get(row.secretReference);
    expect(secret.password).not.toBe(""); // real random password, no longer the pending sentinel
    // A genuine PKCS12 DER blob is binary and parses back via forge — proves it's not just the raw PEM anymore.
    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(secret.p12.toString("binary")));
    expect(() => forge.pkcs12.pkcs12FromAsn1(p12Asn1, secret.password)).not.toThrow();
  });

  it("discards a certificate that reaches a terminal failure state (estado 'r')", async () => {
    const row = await seedPendingCertificate("job-test-revoked");
    mockCertificateResponses({ "job-test-revoked": { estado: "r", public_certificate_pem: null } });

    await finalizePendingFirmaPassCertificates();

    const after = await prisma.certificate.findUnique({ where: { id: row.id } });
    expect(after).toBeNull();
  });
});
