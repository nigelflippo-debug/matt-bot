/**
 * merge-lore.js — Merge seed lore into the persistent volume lore store.
 *
 * Called at startup. Reads /app/data-src/lore.enc (baked into the image),
 * decrypts it, and appends any entries whose IDs are not already in
 * /app/data/lore.json. Never removes or overwrites existing volume entries.
 */

import fs from "fs";
import { loadEncryptedJson } from "./crypto-utils.js";

const seedEncPath = "/app/data-src/lore.enc";
const seedJsonPath = "/app/data-src/lore.json";
const livePath = "/app/data/lore.json";

if (!fs.existsSync(seedEncPath) && !fs.existsSync(seedJsonPath)) {
  console.log("merge-lore: no seed file, skipping");
  process.exit(0);
}

const seed = loadEncryptedJson(seedEncPath, seedJsonPath);

let live = [];
if (fs.existsSync(livePath)) {
  live = JSON.parse(fs.readFileSync(livePath, "utf8"));
}

const liveIds = new Set(live.map((e) => e.id));
const toAdd = seed.filter((e) => !liveIds.has(e.id));

if (toAdd.length === 0) {
  console.log(`merge-lore: live has ${live.length} entries, seed has ${seed.length} — nothing new`);
  process.exit(0);
}

const merged = [...live, ...toAdd];
fs.writeFileSync(livePath, JSON.stringify(merged, null, 2));
console.log(`merge-lore: added ${toAdd.length} new entries (${live.length} → ${merged.length} total)`);
