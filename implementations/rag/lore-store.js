/**
 * lore-store.js — persistent user-curated facts about Matt and the group
 *
 * Entries are always injected into the system prompt as authoritative ground truth.
 * Written via "@MattBot remember: X" in Discord.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lorePath = path.resolve(__dirname, "../../data/lore.json");

function load() {
  if (!fs.existsSync(lorePath)) return [];
  return JSON.parse(fs.readFileSync(lorePath, "utf8"));
}

function save(entries) {
  fs.writeFileSync(lorePath, JSON.stringify(entries, null, 2));
}

/**
 * Add a new lore entry.
 * @param {string} text - the fact or correction to store
 * @param {string} addedBy - display name of the user who added it
 */
export function addLore(text, addedBy = "unknown") {
  const entries = load();
  entries.push({ text, addedBy, addedAt: new Date().toISOString() });
  save(entries);
}

/**
 * Return all lore entries.
 */
export function getAllLore() {
  return load();
}
