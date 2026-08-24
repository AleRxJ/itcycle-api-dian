import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit, standard for GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

/**
 * Shared AES-256-GCM primitives for the at-rest encryption stores
 * (EncryptedFileCertificateSecretStore, PrismaCertificateSecretStore) —
 * kept in one place so both stay byte-compatible: a secret written by one
 * must always be decryptable by the other, since either can be the active
 * CertificateSecretStore depending on STORAGE_DRIVER.
 */
export function parseAesGcmKey(base64Url: string, envVarName: string): Buffer {
  const key = Buffer.from(base64Url, "base64url");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `${envVarName} must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}). ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  return key;
}

/** Layout: [12-byte IV][16-byte auth tag][ciphertext] — everything needed to decrypt, nothing that reveals the plaintext. */
export function aesGcmEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function aesGcmDecrypt(key: Buffer, payload: Buffer): Buffer {
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
