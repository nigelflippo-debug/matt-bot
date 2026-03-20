/**
 * encrypt.js — encrypt content files before deployment
 *
 * Reads:
 *   data/enriched.json  → data/enriched.enc
 *   data/corpus.json    → data/corpus.enc
 *
 * Requires CONTENT_ENCRYPTION_KEY in .env (64-char hex string).
 *
 * Generate a key:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Run after every corpus rebuild:
 *   npm run encrypt
 */

import "dotenv/config";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { keyFromHex, encryptFile } from "./crypto-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../data");

const FILES = [
  { src: "enriched.json", dest: "enriched.enc" },
  { src: "corpus.json",   dest: "corpus.enc"   },
];

const keyHex = process.env.CONTENT_ENCRYPTION_KEY;
if (!keyHex) {
  console.error("Error: CONTENT_ENCRYPTION_KEY is not set in .env");
  process.exit(1);
}

const key = keyFromHex(keyHex);

for (const { src, dest } of FILES) {
  const srcPath  = path.join(dataDir, src);
  const destPath = path.join(dataDir, dest);

  if (!existsSync(srcPath)) {
    console.warn(`  skipping ${src} — file not found`);
    continue;
  }

  encryptFile(srcPath, destPath, key);
  console.log(`  encrypted ${src} → ${dest}`);
}

console.log("Done. Deploy the .enc files; do not deploy the plaintext .json files.");
