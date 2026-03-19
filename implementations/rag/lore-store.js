/**
 * lore-store.js — persistent user-curated memory store
 *
 * Two categories:
 *   directive — behavioral rules for the bot (word bans, style rules, etc.)
 *               Always injected into the system prompt. Cap: DIRECTIVE_CAP.
 *   fact      — everything else (group lore, personal details, ephemeral notes)
 *               Embedded lazily and retrieved semantically at query time. Cap: FACT_CAP.
 *
 * Written via "@MattBot remember: X" in Discord.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { LocalIndex } from "vectra";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lorePath = path.resolve(__dirname, "../../data/lore.json");
const loreIndexPath = path.resolve(__dirname, "../../data/index-lore");

const FACT_CAP = 100;
const DIRECTIVE_CAP = 20;

const openai = new OpenAI();
const loreIndex = new LocalIndex(loreIndexPath);

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function makeId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `lore_${Date.now()}_${rand}`;
}

function load() {
  let entries = [];
  if (fs.existsSync(lorePath)) {
    entries = JSON.parse(fs.readFileSync(lorePath, "utf8"));
  }

  // Migration: backfill id, category, embedded for pre-v2 entries
  let dirty = false;
  for (const entry of entries) {
    if (!entry.id) { entry.id = makeId(); dirty = true; }
    if (!entry.category) { entry.category = "fact"; dirty = true; }
    if (entry.embedded === undefined) { entry.embedded = false; dirty = true; }
  }
  if (dirty) fs.writeFileSync(lorePath, JSON.stringify(entries, null, 2));

  return entries;
}

function save(entries) {
  fs.writeFileSync(lorePath, JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// LLM: classify
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM = `You categorize a memory entry into one of two types.

A "directive" is a behavioral instruction for the bot — a rule about how it should respond. Examples:
- "Don't use the word delve"
- "Always respond in English"
- "Stop saying bro so much"
- "Never bring up X topic"

A "fact" is everything else: a memory, a piece of group lore, a personal detail, an event, a temporary note, anything that is not a rule for the bot's behavior.

Respond with JSON only — no markdown: {"category": "directive"} or {"category": "fact"}`;

async function classify(text) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM },
        { role: "user", content: text },
      ],
    });
    const result = JSON.parse(response.choices[0].message.content);
    return result.category === "directive" ? "directive" : "fact";
  } catch {
    return "fact"; // default: never lose an entry due to classification failure
  }
}

// ---------------------------------------------------------------------------
// LLM: coalesce
// ---------------------------------------------------------------------------

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
    return { action: "add" };
  }
}

// ---------------------------------------------------------------------------
// Public: add
// ---------------------------------------------------------------------------

/**
 * Add a new entry, classifying and coalescing with existing same-category entries first.
 * Returns { action: 'added' | 'merged' | 'skipped' | 'capped', category }
 */
export async function addLore(text, addedBy = "unknown") {
  const entries = load();

  const category = await classify(text);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_classified", category }));

  const sameCat = entries.filter((e) => e.category === category);
  const cap = category === "directive" ? DIRECTIVE_CAP : FACT_CAP;

  if (sameCat.length >= cap) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_capped", category, count: sameCat.length }));
    return { action: "capped", category };
  }

  const result = await coalesce(text, sameCat);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_coalesce", result }));

  if (result.action === "skip") {
    return { action: "skipped", category };
  }

  if (result.action === "merge" && typeof result.index === "number" && sameCat[result.index]) {
    const targetId = sameCat[result.index].id;
    const actualIndex = entries.findIndex((e) => e.id === targetId);
    if (actualIndex !== -1) {
      entries[actualIndex] = {
        ...entries[actualIndex],
        text: result.merged,
        embedded: false, // reset: re-embed on next query
        updatedBy: addedBy,
        updatedAt: new Date().toISOString(),
      };
      save(entries);
      return { action: "merged", category };
    }
  }

  entries.push({
    id: makeId(),
    text,
    category,
    embedded: false,
    addedBy,
    addedAt: new Date().toISOString(),
  });
  save(entries);
  return { action: "added", category };
}

// ---------------------------------------------------------------------------
// Public: remove
// ---------------------------------------------------------------------------

/**
 * Remove all entries whose text contains the given keyword (case-insensitive).
 * Also removes matching entries from the Vectra index.
 * Returns the number of entries removed.
 */
export async function removeLore(keyword) {
  const entries = load();
  const lower = keyword.toLowerCase();

  const toRemove = entries.filter((e) => e.text.toLowerCase().includes(lower));
  if (toRemove.length === 0) return 0;

  const filtered = entries.filter((e) => !e.text.toLowerCase().includes(lower));
  save(filtered);

  // Remove embedded fact entries from the Vectra index
  if (await loreIndex.isIndexCreated()) {
    for (const entry of toRemove) {
      if (entry.embedded && entry.category === "fact") {
        try {
          await loreIndex.deleteItem(entry.id);
        } catch {
          // May not be in index — ignore
        }
      }
    }
  }

  return toRemove.length;
}

// ---------------------------------------------------------------------------
// Public: lazy embedding
// ---------------------------------------------------------------------------

/**
 * Embed any fact entries that haven't been embedded yet.
 * Call this at the start of each bot query — it's a no-op if nothing is pending.
 * Returns the number of entries embedded.
 */
export async function embedPendingLore() {
  const entries = load();
  const pending = entries.filter((e) => e.category === "fact" && e.embedded === false);

  if (pending.length === 0) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_embed_check", pending: 0 }));
    return 0;
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_embed_start", pending: pending.length, ids: pending.map((e) => e.id) }));

  if (!(await loreIndex.isIndexCreated())) {
    await loreIndex.createIndex();
  }

  const embResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: pending.map((e) => e.text),
  });

  await loreIndex.beginUpdate();
  for (let i = 0; i < pending.length; i++) {
    await loreIndex.upsertItem({
      id: pending[i].id,
      vector: embResponse.data[i].embedding,
      metadata: { id: pending[i].id, text: pending[i].text },
    });
  }
  await loreIndex.endUpdate();

  // Mark as embedded
  for (const entry of pending) {
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx !== -1) entries[idx].embedded = true;
  }
  save(entries);

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_embedded", count: pending.length }));
  return pending.length;
}

// ---------------------------------------------------------------------------
// Public: retrieve
// ---------------------------------------------------------------------------

/**
 * Retrieve the top K most relevant fact entries for a given query.
 * embedPendingLore() should be called before this.
 */
export async function retrieveLore(query, k = 5) {
  if (!(await loreIndex.isIndexCreated())) return [];

  const embResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: [query],
  });
  const vector = embResponse.data[0].embedding;

  const results = await loreIndex.queryItems(vector, k);

  const entries = load();
  const entryById = new Map(entries.map((e) => [e.id, e]));

  const retrieved = results.map((r) => entryById.get(r.item.metadata.id)).filter(Boolean);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_retrieve", count: retrieved.length, facts: retrieved.map((e) => e.text.slice(0, 60)) }));
  return retrieved;
}

// ---------------------------------------------------------------------------
// Public: getDirectives
// ---------------------------------------------------------------------------

export function getDirectives() {
  return load().filter((e) => e.category === "directive");
}

// ---------------------------------------------------------------------------
// Public: getAllLore (for list lore command)
// ---------------------------------------------------------------------------

export function getAllLore() {
  return load();
}

// ---------------------------------------------------------------------------
// Public: consolidate
// ---------------------------------------------------------------------------

/**
 * Run a full consolidation pass over all entries.
 * Facts and directives are consolidated separately to avoid cross-contamination.
 * Rebuilds the Vectra index from scratch since IDs change.
 */
export async function consolidateLore() {
  const entries = load();
  if (entries.length < 2) return { before: entries.length, after: entries.length };

  const facts = entries.filter((e) => e.category === "fact");
  const directives = entries.filter((e) => e.category === "directive");

  async function consolidateGroup(group) {
    if (group.length < 2) return group.map((e) => e.text);
    const list = group.map((e, i) => `${i}: ${e.text}`).join("\n");
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
    const result = JSON.parse(response.choices[0].message.content).facts;
    if (!Array.isArray(result)) throw new Error("unexpected shape");
    return result;
  }

  const [consolidatedFacts, consolidatedDirectives] = await Promise.all([
    consolidateGroup(facts),
    consolidateGroup(directives),
  ]);

  const now = new Date().toISOString();
  const newEntries = [
    ...consolidatedFacts.map((text) => ({
      id: makeId(),
      text,
      category: "fact",
      embedded: false,
      addedBy: "consolidation",
      addedAt: now,
    })),
    ...consolidatedDirectives.map((text) => ({
      id: makeId(),
      text,
      category: "directive",
      embedded: false,
      addedBy: "consolidation",
      addedAt: now,
    })),
  ];

  save(newEntries);

  // Rebuild the lore index from scratch — all IDs have changed
  if (fs.existsSync(loreIndexPath)) {
    fs.rmSync(loreIndexPath, { recursive: true, force: true });
  }

  const before = entries.length;
  const after = newEntries.length;
  console.log(JSON.stringify({ ts: now, stage: "lore_consolidated", before, after }));
  return { before, after };
}
