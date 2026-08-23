import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EncryptedFileCertificateSecretStore } from "./EncryptedFileCertificateSecretStore.js";

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "itcycle-encrypted-cert-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("EncryptedFileCertificateSecretStore", () => {
  it("round-trips a certificate and password through save/get", async () => {
    const masterKey = randomBytes(32).toString("base64url");
    const store = new EncryptedFileCertificateSecretStore(baseDir, masterKey);
    const secret = { p12: Buffer.from("fake p12 bytes"), password: "s3cr3t-password" };

    await store.save("ref-1", secret);
    const retrieved = await store.get("ref-1");

    expect(retrieved.p12.equals(secret.p12)).toBe(true);
    expect(retrieved.password).toBe(secret.password);
  });

  it("never writes the plaintext to disk", async () => {
    const masterKey = randomBytes(32).toString("base64url");
    const store = new EncryptedFileCertificateSecretStore(baseDir, masterKey);
    const secret = { p12: Buffer.from("very-identifiable-p12-marker"), password: "very-identifiable-password" };

    await store.save("ref-2", secret);

    const [p12OnDisk, passwordOnDisk] = await Promise.all([
      readFile(join(baseDir, "ref-2.p12.enc")),
      readFile(join(baseDir, "ref-2.password.enc")),
    ]);

    expect(p12OnDisk.includes("very-identifiable-p12-marker")).toBe(false);
    expect(passwordOnDisk.toString("latin1").includes("very-identifiable-password")).toBe(false);
  });

  it("fails to decrypt with the wrong master key", async () => {
    const store = new EncryptedFileCertificateSecretStore(baseDir, randomBytes(32).toString("base64url"));
    await store.save("ref-3", { p12: Buffer.from("data"), password: "pw" });

    const wrongKeyStore = new EncryptedFileCertificateSecretStore(baseDir, randomBytes(32).toString("base64url"));
    await expect(wrongKeyStore.get("ref-3")).rejects.toThrow();
  });

  it("deletes both files", async () => {
    const store = new EncryptedFileCertificateSecretStore(baseDir, randomBytes(32).toString("base64url"));
    await store.save("ref-4", { p12: Buffer.from("data"), password: "pw" });

    await store.delete("ref-4");

    await expect(store.get("ref-4")).rejects.toThrow();
  });

  it("rejects a master key that isn't exactly 32 bytes", () => {
    expect(() => new EncryptedFileCertificateSecretStore(baseDir, Buffer.from("too-short").toString("base64url"))).toThrow(
      /32 bytes/,
    );
  });
});
