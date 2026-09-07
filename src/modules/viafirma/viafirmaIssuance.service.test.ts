import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same rationale as admin.service.test.ts: vi.mock is the one mechanism
// guaranteed to run before env.js is evaluated (ESM hoists imports ahead
// of this file's own top-level statements).
vi.mock("../../shared/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/env.js")>();
  return {
    ...actual,
    env: { ...actual.env, viafirmaConsumerKey: "test-key", viafirmaConsumerSecret: "test-secret", viafirmaRa: "viafirmaco" },
  };
});

const mockGetAvailableProfiles = vi.fn();
const mockCreateRequestFromCsr = vi.fn();
const mockGetStatus = vi.fn();

// Real network/Sandbox calls are exactly what this test suite must NOT
// make — mock only ViafirmaCertificateProvider's class, keep every pure
// export (generateKeyPairAndCsr, mapViafirmaStatus, assemblePkcs12FromP7b,
// types) real so the orchestration is exercised against real CSR/key
// generation, same discipline as the provider's own unit tests.
vi.mock("../../providers/certificates/ViafirmaCertificateProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/certificates/ViafirmaCertificateProvider.js")>();
  return {
    ...actual,
    ViafirmaCertificateProvider: vi.fn().mockImplementation(() => ({
      getAvailableProfiles: mockGetAvailableProfiles,
      createRequestFromCsr: mockCreateRequestFromCsr,
      getStatus: mockGetStatus,
    })),
  };
});

import { prisma } from "../../infrastructure/prisma.js";
import { createCompany } from "../admin/admin.service.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { createViafirmaRequest, getViafirmaCertificateStatus } from "./viafirmaIssuance.service.js";

const TEST_NIT = "999000009";
const TEST_DV = "3";

const FAKE_PROFILE = {
  code: "CODE_PJ",
  title: "FE-PJ en formato PKCS10",
  description: "",
  ra: "viafirmaco",
  type: "CORPORATIVO" as const,
  dnPattern: "",
  altPattern: "",
  terms: "",
  validity: 730,
  token: "P7B" as const,
};

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

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createViafirmaRequest", () => {
  it("creates a Certificate row, stashes the private key, and records publicId in providerMetadata", async () => {
    const company = await createCompany({ name: "Viafirma Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });
    mockGetAvailableProfiles.mockResolvedValue([FAKE_PROFILE]);
    mockCreateRequestFromCsr.mockResolvedValue({ codRequest: "REQ123", publicId: "PUB123" });

    const result = await createViafirmaRequest({
      companyId: company.id,
      profileKind: "FE-PJ",
      subject: PJ_SUBJECT,
      identityType: "IDC",
      countryCode: "CO",
      identity: "123",
      emailCertificate: "info@mail.com",
    });

    expect(result.codRequest).toBe("REQ123");
    expect(mockCreateRequestFromCsr).toHaveBeenCalledTimes(1);
    const sentPayload = mockCreateRequestFromCsr.mock.calls[0]![0];
    expect(sentPayload.codProfile).toBe("CODE_PJ");
    expect(typeof sentPayload.csr).toBe("string");
    // The CSR sent to Viafirma is base64-encoded PEM, never the raw private key.
    expect(Buffer.from(sentPayload.csr, "base64").toString("utf-8")).toMatch(/CERTIFICATE REQUEST/);

    const certificate = await prisma.certificate.findUniqueOrThrow({ where: { id: result.certificateId } });
    expect(certificate.provider).toBe("viafirma");
    expect(certificate.certificateIdentifier).toBe("REQ123");
    expect(certificate.status).toBe("INACTIVE");
    expect(certificate.expiresAt).toBeNull();
    expect((certificate.providerMetadata as { publicId: string }).publicId).toBe("PUB123");

    const secretStore = createDefaultCertificateSecretStore();
    const secret = await secretStore.get(certificate.secretReference);
    expect(secret.password).toBe(""); // documented "not finalized yet" sentinel
    expect(secret.p12.toString("utf-8")).toMatch(/PRIVATE KEY/);

    await secretStore.delete(certificate.secretReference);
    await prisma.certificate.delete({ where: { id: certificate.id } });
  });

  it("cleans up the stashed private key when the Viafirma request itself fails", async () => {
    const company = await createCompany({ name: "Viafirma Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });
    mockGetAvailableProfiles.mockResolvedValue([FAKE_PROFILE]);
    mockCreateRequestFromCsr.mockRejectedValue(new Error("Viafirma is down"));

    await expect(
      createViafirmaRequest({
        companyId: company.id,
        profileKind: "FE-PJ",
        subject: PJ_SUBJECT,
        identityType: "IDC",
        countryCode: "CO",
        identity: "123",
        emailCertificate: "info@mail.com",
      }),
    ).rejects.toThrow("Viafirma is down");

    const certificates = await prisma.certificate.findMany({ where: { companyId: company.id } });
    expect(certificates).toHaveLength(0);
  });

  it("throws a clear error instead of guessing when no profile of the requested type is available", async () => {
    const company = await createCompany({ name: "Viafirma Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });
    mockGetAvailableProfiles.mockResolvedValue([]);

    await expect(
      createViafirmaRequest({
        companyId: company.id,
        profileKind: "FE-PJ",
        subject: PJ_SUBJECT,
        identityType: "IDC",
        countryCode: "CO",
        identity: "123",
        emailCertificate: "info@mail.com",
      }),
    ).rejects.toThrow(/No Viafirma profile/);
  });
});

describe("getViafirmaCertificateStatus", () => {
  it("scopes lookup by companyId — never returns another company's certificate", async () => {
    const company = await createCompany({ name: "Viafirma Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" });
    mockGetAvailableProfiles.mockResolvedValue([FAKE_PROFILE]);
    mockCreateRequestFromCsr.mockResolvedValue({ codRequest: "REQ456", publicId: "PUB456" });

    const { certificateId } = await createViafirmaRequest({
      companyId: company.id,
      profileKind: "FE-PJ",
      subject: PJ_SUBJECT,
      identityType: "IDC",
      countryCode: "CO",
      identity: "123",
      emailCertificate: "info@mail.com",
    });

    mockGetStatus.mockResolvedValue({
      internalStatus: "pending_provider_review",
      providerStatus: "rues_check",
      requiresUserAction: false,
      requiresSupportIntervention: false,
    });

    const status = await getViafirmaCertificateStatus({ companyId: company.id, certificateId });
    expect(status.internalStatus).toBe("pending_provider_review");
    expect(mockGetStatus).toHaveBeenCalledWith("REQ456");

    await expect(getViafirmaCertificateStatus({ companyId: "not-this-company", certificateId })).rejects.toThrow(/not found/);
  });
});
