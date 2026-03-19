/**
 * lore-store.js — persistent user-curated facts about Matt and the group
 *
 * Entries are always injected into the system prompt as authoritative ground truth.
 * Written via "@MattBot remember: X" in Discord.
 *
 * On every write, an LLM coalesce pass runs to merge duplicates, skip already-covered
 * facts, or append genuinely new ones. Hard cap at LORE_CAP entries.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lorePath = path.resolve(__dirname, "../../data/lore.json");

const LORE_CAP = 100;

const openai = new OpenAI();

function load() {
  if (!fs.existsSync(lorePath)) return [];
  return JSON.parse(fs.readFileSync(lorePath, "utf8"));
}

function save(entries) {
  fs.writeFileSync(lorePath, JSON.stringify(entries, null, 2));
}

const COALESCE_SYSTEM = `You manage a compact fact store. Given an existing list of facts and a new candidate fact, decide what to do.

Respond with a JSON object — no markdown, no explanation, just the JSON:

If the new fact is already fully covered by an existing entry:
{"action":"skip"}

If the new fact updates, corrects, or extends an existing entry, return the index (0-based) of that entry and the merged replacement text:
{"action":"merge","index":<n>,"merged":"<full replacement text>"}

If the new fact is genuinely new information not covered by any existing entry:
{"action":"add"}

Rules:
- Prefer merging over adding when the topic overlaps at all
- The merged text should be a single clean sentence or phrase, no longer than the longer of the two inputs
- Do not invent details not present in either entry`;

/**
 * Run LLM coalesce check. Returns the action to take.
 */
async function coalesce(newFact, entries) {
  if (entries.length === 0) return { action: "add" };

  const existingList = entries.map((e, i) => `${i}: ${e.text}`).join("\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: COALESCE_SYSTEM },
      {
        role: "user",
        content: `EXISTING FACTS:\n${existingList}\n\nNEW FACT:\n${newFact}`,
      },
    ],
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    // If parsing fails, default to add
    return { action: "add" };
  }
}

/**
 * Add a new lore entry, coalescing with existing entries first.
 *
 * Returns { action: 'added' | 'merged' | 'skipped' | 'capped' }
 */
export async function addLore(text, addedBy = "unknown") {
  const entries = load();

  if (entries.length >= LORE_CAP) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_capped", count: entries.length }));
    return { action: "capped" };
  }

  const result = await coalesce(text, entries);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_coalesce", result }));

  if (result.action === "skip") {
    return { action: "skipped" };
  }

  if (result.action === "merge" && typeof result.index === "number" && entries[result.index]) {
    entries[result.index] = {
      ...entries[result.index],
      text: result.merged,
      updatedBy: addedBy,
      updatedAt: new Date().toISOString(),
    };
    save(entries);
    return { action: "merged" };
  }

  // action === "add"
  entries.push({ text, addedBy, addedAt: new Date().toISOString() });
  save(entries);
  return { action: "added" };
}

/**
 * Remove all entries whose text contains the given keyword (case-insensitive).
 * Returns the number of entries removed.
 */
export function removeLore(keyword) {
  const entries = load();
  const lower = keyword.toLowerCase();
  const filtered = entries.filter((e) => !e.text.toLowerCase().includes(lower));
  const removed = entries.length - filtered.length;
  if (removed > 0) save(filtered);
  return removed;
}

/**
 * Run a full coalesce pass over all existing entries.
 * Merges duplicates, consolidates related facts, drops redundant entries.
 * Returns { before, after } counts.
 */
export async function consolidateLore() {
  const entries = load();
  if (entries.length < 2) return { before: entries.length, after: entries.length };

  const list = entries.map((e, i) => `${i}: ${e.text}`).join("\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are consolidating a fact store. Given a numbered list of facts, return a deduplicated, merged version.

Rules:
- Merge entries that share a topic, person, or theme into one entry
- Drop entries that are fully covered by another
- Preserve all unique information — do not lose facts
- A merged entry can be 1-2 sentences if needed to retain distinct details
- Return JSON: {"facts": ["fact1", "fact2", ...]}`,
      },
      { role: "user", content: list },
    ],
  });

  let consolidated;
  try {
    consolidated = JSON.parse(response.choices[0].message.content).facts;
    if (!Array.isArray(consolidated)) throw new Error("unexpected shape");
  } catch {
    throw new Error("Consolidation failed — LLM returned unexpected output");
  }

  const now = new Date().toISOString();
  const newEntries = consolidated.map((text) => ({ text, addedBy: "consolidation", addedAt: now }));
  save(newEntries);

  console.log(JSON.stringify({ ts: now, stage: "lore_consolidated", before: entries.length, after: newEntries.length }));
  return { before: entries.length, after: newEntries.length };
}

/**
 * Return all lore entries.
 */
export function getAllLore() {
  return load();
}
