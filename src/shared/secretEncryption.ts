import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit, standard for GCM
const KEY_LENGTH = 32; // AES-256
const AUTH_TAG_LENGTH = 16;

/**
 * AES-256-GCM at rest for Company.firmaPassLoginKeyCiphertext — unlike
 * CertificateSecretStore (which holds .p12 bytes for signing, see
 * providers/certificates/), a FirmaPass login key is a plain config string
 * this app must be able to decrypt again to call the FirmaPass API on the
 * company's behalf.
 *
 * FIRMAPASS_ENCRYPTION_KEY must be 32 raw bytes, base64url-encoded, and is a
 * completely separate key from CERTIFICATE_ENCRYPTION_KEY — same principle
 * that keeps Ohnix's own SECRET_ENCRYPTION_KEY separate from this repo's
 * CERTIFICATE_ENCRYPTION_KEY (see Backend/utils/secretEncryption.js there).
 * Never reuse an encryption key across unrelated secret categories.
 */
function getMasterKey(): Buffer {
  const raw = process.env.FIRMAPASS_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(raw, "base64url");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `FIRMAPASS_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}). ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  return key;
}

/** Layout: base64url([12-byte IV][16-byte auth tag][ciphertext]) — a single string column holds this. */
export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptSecret(encoded: string): string {
  const key = getMasterKey();
  const payload = Buffer.from(encoded, "base64url");
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}
