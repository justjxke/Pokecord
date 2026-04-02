import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

import type { EncryptedSecret } from "./types";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

function deriveKey(masterSecret: string, salt: Buffer): Buffer {
  return scryptSync(masterSecret, salt, KEY_LENGTH);
}

function toBase64(value: Buffer): string {
  return value.toString("base64");
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function assertSecretShape(secret: EncryptedSecret): void {
  if (secret.algorithm !== ALGORITHM) {
    throw new Error("Unsupported secret algorithm.");
  }
}

export function encryptTenantSecret(plaintext: string, masterSecret: string, createdAt = Date.now()): EncryptedSecret {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(masterSecret, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    algorithm: ALGORITHM,
    salt: toBase64(salt),
    iv: toBase64(iv),
    tag: toBase64(tag),
    ciphertext: toBase64(ciphertext),
    createdAt
  };
}

export function decryptTenantSecret(secret: EncryptedSecret, masterSecret: string): string {
  assertSecretShape(secret);

  const decipher = createDecipheriv(ALGORITHM, deriveKey(masterSecret, fromBase64(secret.salt)), fromBase64(secret.iv));
  decipher.setAuthTag(fromBase64(secret.tag));
  return Buffer.concat([decipher.update(fromBase64(secret.ciphertext)), decipher.final()]).toString("utf8");
}

