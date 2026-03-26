/**
 * encrypt.js — encrypt content files before deployment
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
import { keyFromHex, encryptFile } from "../src/rag/crypto-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data");
const personasDir = path.resolve(__dirname, "../personas");

// Parse --persona flag (default: encrypt all known personas)
const args = process.argv.slice(2);
const personaArg = args.indexOf("--persona") !== -1 ? args[args.indexOf("--persona") + 1] : null;

// Shared files (always encrypted)
const FILES = [
  { src: "corpus.json", dest: "corpus.enc", dir: dataDir },
];

// Discover persona directories and add per-persona files
const fs = await import("fs");
const personaDirs = personaArg
  ? [personaArg]
  : fs.readdirSync(personasDir).filter((d) => fs.statSync(path.join(personasDir, d)).isDirectory());

for (const pid of personaDirs) {
  const pDataDir = path.join(dataDir, "personas", pid);
  const pPersonaDir = path.join(personasDir, pid);

  FILES.push({ src: "enriched.json", dest: "enriched.enc", dir: pDataDir });
  FILES.push({ src: "memory.json", dest: "memory.enc", dir: pDataDir });
  FILES.push({ src: "system-prompt.md", dest: "system-prompt.enc", dir: pPersonaDir });
}

const keyHex = process.env.CONTENT_ENCRYPTION_KEY;
if (!keyHex) {
  console.error("Error: CONTENT_ENCRYPTION_KEY is not set in .env");
  process.exit(1);
}

const key = keyFromHex(keyHex);

for (const { src, dest, dir } of FILES) {
  const srcPath  = path.join(dir, src);
  const destPath = path.join(dir, dest);

  if (!existsSync(srcPath)) {
    console.warn(`  skipping ${src} — file not found`);
    continue;
  }

  encryptFile(srcPath, destPath, key);
  console.log(`  encrypted ${src} → ${dest}`);
}

console.log("Done. Deploy the .enc files; do not deploy the plaintext .json files.");
