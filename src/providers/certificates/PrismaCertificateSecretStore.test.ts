import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../../infrastructure/prisma.js";
import { PrismaCertificateSecretStore } from "./PrismaCertificateSecretStore.js";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PrismaCertificateSecretStore", () => {
  it("round-trips a certificate and password through save/get", async () => {
    const store = new PrismaCertificateSecretStore(prisma, randomBytes(32).toString("base64url"));
    const reference = randomUUID();
    const secret = { p12: Buffer.from("fake p12 bytes"), password: "s3cr3t-password" };

    try {
      await store.save(reference, secret);
      const retrieved = await store.get(reference);

      expect(retrieved.p12.equals(secret.p12)).toBe(true);
      expect(retrieved.password).toBe(secret.password);
    } finally {
      await store.delete(reference);
    }
  });

  it("never persists the plaintext in the row", async () => {
    const store = new PrismaCertificateSecretStore(prisma, randomBytes(32).toString("base64url"));
    const reference = randomUUID();
    const secret = { p12: Buffer.from("very-identifiable-p12-marker"), password: "very-identifiable-password" };

    try {
      await store.save(reference, secret);
      const row = await prisma.certificateSecretBlob.findUniqueOrThrow({ where: { reference } });

      expect(Buffer.from(row.p12Ciphertext).includes("very-identifiable-p12-marker")).toBe(false);
      expect(Buffer.from(row.passwordCiphertext).toString("latin1").includes("very-identifiable-password")).toBe(
        false,
      );
    } finally {
      await store.delete(reference);
    }
  });

  it("fails to decrypt with the wrong master key", async () => {
    const store = new PrismaCertificateSecretStore(prisma, randomBytes(32).toString("base64url"));
    const reference = randomUUID();

    try {
      await store.save(reference, { p12: Buffer.from("data"), password: "pw" });

      const wrongKeyStore = new PrismaCertificateSecretStore(prisma, randomBytes(32).toString("base64url"));
      await expect(wrongKeyStore.get(reference)).rejects.toThrow();
    } finally {
      await store.delete(reference);
    }
  });

  it("save is idempotent (upsert) for the same reference", async () => {
    const store = new PrismaCertificateSecretStore(prisma, randomBytes(32).toString("base64url"));
    const reference = randomUUID();

    try {
      await store.save(reference, { p12: Buffer.from("first"), password: "pw-1" });
      await store.save(reference, { p12: Buffer.from("second"), password: "pw-2" });

      const retrieved = await store.get(reference);
      expect(retrieved.p12.toString()).toBe("second");
      expect(retrieved.password).toBe("pw-2");
    } finally {
      await store.delete(reference);
    }
  });

  it("delete removes the row", async () => {
    const store = new PrismaCertificateSecretStore(prisma, randomBytes(32).toString("base64url"));
    const reference = randomUUID();
    await store.save(reference, { p12: Buffer.from("data"), password: "pw" });

    await store.delete(reference);

    await expect(store.get(reference)).rejects.toThrow();
  });

  it("rejects a master key that isn't exactly 32 bytes", () => {
    expect(() => new PrismaCertificateSecretStore(prisma, Buffer.from("too-short").toString("base64url"))).toThrow(
      /32 bytes/,
    );
  });
});
