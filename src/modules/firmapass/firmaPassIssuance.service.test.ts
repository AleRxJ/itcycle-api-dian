import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.FIRMAPASS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64url");

const confirmarMock = vi.fn();

vi.mock("../../providers/firmapass/FirmaPassClient.js", () => ({
  FirmaPassClient: vi.fn().mockImplementation(() => ({
    confirmar: confirmarMock,
  })),
}));

import { prisma } from "../../infrastructure/prisma.js";
import { createDefaultCertificateSecretStore } from "../../shared/certificateStore.js";
import { decryptSecret } from "../../shared/secretEncryption.js";
import { confirmValidation, setFirmaPassLoginKey } from "./firmaPassIssuance.service.js";

const TEST_NIT = "999000008";
const TEST_DV = "1";

let companyId: string;

async function cleanup(): Promise<void> {
  const company = await prisma.company.findUnique({ where: { nit_dv: { nit: TEST_NIT, dv: TEST_DV } } });
  if (!company) return;
  await prisma.certificate.deleteMany({ where: { companyId: company.id } });
  await prisma.company.delete({ where: { id: company.id } });
}

beforeAll(async () => {
  await cleanup();
  const company = await prisma.company.create({
    data: { name: "FirmaPass Issuance Test Co", nit: TEST_NIT, dv: TEST_DV, personType: "1" },
  });
  companyId = company.id;
  await setFirmaPassLoginKey(companyId, "test-login-key");
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("setFirmaPassLoginKey", () => {
  it("stores the login key encrypted, and it round-trips via decryptSecret", async () => {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(company.firmaPassLoginKeyCiphertext).toBeTruthy();
    expect(company.firmaPassLoginKeyCiphertext).not.toContain("test-login-key");
    expect(decryptSecret(company.firmaPassLoginKeyCiphertext as string)).toBe("test-login-key");
  });
});

describe("confirmValidation", () => {
  it("stashes the raw private key and creates an INACTIVE Certificate row with no expiresAt yet", async () => {
    confirmarMock.mockResolvedValueOnce({
      message: "ok",
      certificate: { uuid: "cert-uuid-1", identificador: "cert-ident-1", estado: "pe", estado_descripcion: "En espera" },
      private_key_pem: "-----BEGIN PRIVATE KEY-----\nFAKEPEMDATA\n-----END PRIVATE KEY-----",
    });

    const result = await confirmValidation({ companyId, validationUuid: "validation-uuid-1" });

    expect(result.estado).toBe("pe");
    expect(result.certificateIdentifier).toBe("cert-ident-1");

    const stored = await prisma.certificate.findUniqueOrThrow({ where: { id: result.certificateId } });
    expect(stored.status).toBe("INACTIVE");
    expect(stored.expiresAt).toBeNull();
    expect(stored.provider).toBe("firmapass");

    const secretStore = createDefaultCertificateSecretStore();
    const secret = await secretStore.get(stored.secretReference);
    expect(secret.password).toBe("");
    expect(secret.p12.toString("utf-8")).toContain("FAKEPEMDATA");
  });

  it("rejects a centralized-signature certificate (private_key_pem null) without creating a Certificate row", async () => {
    confirmarMock.mockResolvedValueOnce({
      message: "ok",
      certificate: { uuid: "cert-uuid-2", identificador: "cert-ident-2", estado: "pe", estado_descripcion: "En espera" },
      private_key_pem: null,
    });

    await expect(confirmValidation({ companyId, validationUuid: "validation-uuid-2" })).rejects.toThrow(
      /centralized/i,
    );

    const stored = await prisma.certificate.findFirst({ where: { certificateIdentifier: "cert-ident-2" } });
    expect(stored).toBeNull();
  });
});
