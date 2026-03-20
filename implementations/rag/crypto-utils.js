/**
 * crypto-utils.js — AES-256-GCM encryption/decryption for content files
 *
 * Format: iv (12 bytes) || authTag (16 bytes) || ciphertext
 *
 * Usage:
 *   - encryptFile(src, dest, key) — write encrypted file
 *   - loadEncryptedJson(encPath, jsonPath) — decrypt .enc or fall back to .json for local dev
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { readFileSync, existsSync, writeFileSync } from "fs";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function keyFromHex(hex) {
  if (!hex || hex.length !== 64) {
    throw new Error("CONTENT_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptFile(srcPath, destPath, key) {
  const plaintext = readFileSync(srcPath);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  writeFileSync(destPath, Buffer.concat([iv, authTag, ciphertext]));
}

function decryptBuffer(buf, key) {
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Content decryption failed: invalid key or corrupted file");
  }
}

/**
 * Load a JSON data file, preferring the encrypted .enc version.
 *
 * - .enc exists + key set  → decrypt and parse (normal production path)
 * - .enc exists + key missing → throw (misconfigured deployment)
 * - .enc missing + json exists → parse plaintext (local dev without running encrypt)
 * - neither exists → throw
 */
export function loadEncryptedJson(encPath, jsonPath) {
  if (existsSync(encPath)) {
    const keyHex = process.env.CONTENT_ENCRYPTION_KEY;
    if (!keyHex) {
      throw new Error(
        `Encrypted file found at ${encPath} but CONTENT_ENCRYPTION_KEY is not set.`
      );
    }
    const key = keyFromHex(keyHex);
    const buf = readFileSync(encPath);
    return JSON.parse(decryptBuffer(buf, key).toString("utf8"));
  }

  if (existsSync(jsonPath)) {
    return JSON.parse(readFileSync(jsonPath, "utf8"));
  }

  throw new Error(`Neither ${encPath} nor ${jsonPath} found.`);
}
