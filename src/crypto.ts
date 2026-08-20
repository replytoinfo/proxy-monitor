import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
// Format: hex(iv):hex(authTag):hex(ciphertext)
const ENCRYPTED_PATTERN = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/;

function getKey(): Buffer | null {
  if (!config.ENCRYPTION_KEY) return null;
  const key = Buffer.from(config.ENCRYPTION_KEY, "hex");
  if (key.length !== 32) {
    console.error(
      "[crypto] ENCRYPTION_KEY must be 64 hex chars (32 bytes). Encryption disabled."
    );
    return null;
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const key = getKey();
  if (!key) return stored;

  // Not encrypted — return as-is
  if (!ENCRYPTED_PATTERN.test(stored)) return stored;

  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  try {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    console.error("[crypto] Decryption failed — returning stored value");
    return stored;
  }
}

export function isEncrypted(value: string): boolean {
  return ENCRYPTED_PATTERN.test(value);
}

export function isEncryptionEnabled(): boolean {
  return getKey() !== null;
}
