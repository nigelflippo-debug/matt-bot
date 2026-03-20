/**
 * lore-store.js — persistent user-curated memory store
 *
 * Four categories:
 *   directive   — behavioral rules for the bot. Always injected into system prompt. Cap: DIRECTIVE_CAP.
 *   fact        — permanent lore, personal details, events. Retrieved semantically at query time.
 *   episodic    — temporary context (expires in 7 days). Retrieved semantically; pruned at startup.
 *   provisional — uncertain/inferred (future: implicit extraction). Not injected into prompts.
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
  // Also backfill v3 governance fields: confidence, source, lifespan, expiresAt, scope, updatedAt
  let dirty = false;
  for (const entry of entries) {
    if (!entry.id) { entry.id = makeId(); dirty = true; }
    if (!entry.category) { entry.category = "fact"; dirty = true; }
    if (entry.embedded === undefined) { entry.embedded = false; dirty = true; }
    if (entry.confidence === undefined) { entry.confidence = 1.0; dirty = true; }
    if (entry.source === undefined) {
      entry.source = entry.addedBy === "consolidation" ? "bulk-import" : "explicit";
      dirty = true;
    }
    if (entry.lifespan === undefined) { entry.lifespan = "permanent"; dirty = true; }
    if (!Object.prototype.hasOwnProperty.call(entry, "expiresAt")) { entry.expiresAt = null; dirty = true; }
    if (entry.scope === undefined) { entry.scope = "global"; dirty = true; }
    if (!Object.prototype.hasOwnProperty.call(entry, "updatedAt")) { entry.updatedAt = null; dirty = true; }
  }
  if (dirty) fs.writeFileSync(lorePath, JSON.stringify(entries, null, 2));

  return entries;
}

function save(entries) {
  fs.writeFileSync(lorePath, JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Remove entries whose expiresAt is set and in the past.
 * Call at startup. Returns the number of entries pruned.
 */
export function pruneExpired() {
  const entries = load();
  const now = new Date();
  const kept = [];
  const pruned = [];

  for (const entry of entries) {
    if (entry.expiresAt) {
      let expires;
      try { expires = new Date(entry.expiresAt); } catch { kept.push(entry); continue; }
      if (isNaN(expires.getTime())) { kept.push(entry); continue; }
      if (expires < now) { pruned.push(entry); continue; }
    }
    kept.push(entry);
  }

  if (pruned.length > 0) {
    save(kept);
    console.log(JSON.stringify({ ts: now.toISOString(), stage: "lore_pruned", count: pruned.length, ids: pruned.map((e) => e.id) }));
  }

  return pruned.length;
}

// ---------------------------------------------------------------------------
// LLM: classify
// ---------------------------------------------------------------------------

const SPLIT_OR_CLASSIFY_SYSTEM = `You process a memory entry for a fact store. Break it into one or more categorized parts.

Categories:
- "directive" — a behavioral rule for the bot (how it should speak or respond). Examples: "Don't use the word delve", "Never bring up X topic"
- "fact" — a permanent memory, lore, personal detail, or event. Default for most entries.
- "episodic" — explicitly temporary information. Use when the input contains phrases like "for now", "this weekend", "temporarily", "just for today", or other clear short-term signals.

Return a JSON object with a "parts" array. Each part has "text" and "category".
If the entry is a single thing, return one part. If it mixes facts and directives, split them into separate parts — one per distinct fact or rule.

{"parts": [{"text": "...", "category": "fact"|"directive"|"episodic"}, ...]}

Only split when parts are clearly distinct. When in doubt, return a single part.
Respond with JSON only — no markdown.`;

/**
 * Classify and optionally split a text into categorized parts.
 * Returns an array of {text, category} objects.
 */
async function splitOrClassify(text) {
  const VALID_CATEGORIES = new Set(["directive", "fact", "episodic"]);
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SPLIT_OR_CLASSIFY_SYSTEM },
        { role: "user", content: text },
      ],
    });
    const result = JSON.parse(response.choices[0].message.content);
    if (Array.isArray(result.parts) && result.parts.length > 0) {
      return result.parts.map((p) => ({
        text: p.text ?? text,
        category: VALID_CATEGORIES.has(p.category) ? p.category : "fact",
      }));
    }
    return [{ text, category: "fact" }];
  } catch {
    return [{ text, category: "fact" }]; // default: never lose an entry
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
 * Add a new entry, splitting if it contains both a fact and a directive,
 * then coalescing each part with existing same-category entries.
 * Returns { action: 'added' | 'merged' | 'skipped' | 'capped' | 'split', category? }
 */
export async function addLore(text, addedBy = "unknown") {
  const parts = await splitOrClassify(text);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_classified", parts: parts.map((p) => p.category) }));

  if (parts.length > 1) {
    await Promise.all(parts.map((p) => addSingle(p.text, p.category, addedBy)));
    return { action: "split" };
  }

  return addSingle(parts[0].text, parts[0].category, addedBy);
}

async function addSingle(text, category, addedBy) {
  const entries = load();
  const sameCat = entries.filter((e) => e.category === category);

  if (category === "directive" && sameCat.length >= DIRECTIVE_CAP) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_capped", category, count: sameCat.length }));
    return { action: "capped", category };
  }

  const result = await coalesce(text, sameCat);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_coalesce", category, result }));

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
        embedded: false,
        updatedBy: addedBy,
        updatedAt: new Date().toISOString(),
      };
      save(entries);
      return { action: "merged", category };
    }
  }

  const confidenceByCategory = { directive: 1.0, fact: 1.0, episodic: 0.8, provisional: 0.6 };
  const lifespanByCategory = { directive: "permanent", fact: "permanent", episodic: "temporary", provisional: "long-lived" };
  const now = new Date();
  const expiresAt = category === "episodic" ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() : null;

  entries.push({
    id: makeId(),
    text,
    category,
    confidence: confidenceByCategory[category] ?? 1.0,
    source: "explicit",
    lifespan: lifespanByCategory[category] ?? "permanent",
    expiresAt,
    scope: "global",
    embedded: false,
    addedBy,
    addedAt: now.toISOString(),
    updatedAt: null,
  });
  save(entries);
  return { action: "added", category };
}

// ---------------------------------------------------------------------------
// Public: remove
// ---------------------------------------------------------------------------

/**
 * Remove entries semantically matching the query.
 * Facts/episodic: vector search. Directives: LLM match against full list (max 20).
 * Returns { removed: number, entries: [{id, text, category}] }
 */
export async function removeLore(query) {
  const entries = load();

  // --- Semantic search for facts/episodic via vector index ---
  const semanticMatches = [];
  if (await loreIndex.isIndexCreated()) {
    const embResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: [query],
    });
    const results = await loreIndex.queryItems(embResponse.data[0].embedding, 5);
    const entryById = new Map(entries.map((e) => [e.id, e]));
    for (const r of results) {
      const entry = entryById.get(r.item.metadata.id);
      if (entry && r.score > 0.3) semanticMatches.push(entry);
    }
  }

  // --- LLM match for directives ---
  const directives = entries.filter((e) => e.category === "directive");
  const directiveMatches = [];
  if (directives.length > 0) {
    const list = directives.map((e, i) => `${i}: ${e.text}`).join("\n");
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Given a list of directives and a user query, return the indices of any directives the user is trying to remove. Only include directives that clearly match the intent. Return {"indices": []} if nothing matches.\nRespond with JSON only.`,
        },
        { role: "user", content: `DIRECTIVES:\n${list}\n\nQUERY: ${query}` },
      ],
    });
    try {
      const result = JSON.parse(response.choices[0].message.content);
      for (const i of result.indices ?? []) {
        if (directives[i]) directiveMatches.push(directives[i]);
      }
    } catch { /* ignore parse errors */ }
  }

  // Deduplicate by id
  const seen = new Set();
  const toRemove = [...semanticMatches, ...directiveMatches].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  if (toRemove.length === 0) return { removed: 0, entries: [] };

  const removeIds = new Set(toRemove.map((e) => e.id));
  save(entries.filter((e) => !removeIds.has(e.id)));

  // Remove from vector index
  if (await loreIndex.isIndexCreated()) {
    for (const entry of toRemove) {
      if (entry.embedded) {
        try { await loreIndex.deleteItem(entry.id); } catch { /* ignore */ }
      }
    }
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_removed", count: toRemove.length, ids: toRemove.map((e) => e.id) }));
  return { removed: toRemove.length, entries: toRemove.map((e) => ({ id: e.id, text: e.text, category: e.category })) };
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
  const pending = entries.filter((e) => (e.category === "fact" || e.category === "episodic") && e.embedded === false);

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
      metadata: { id: pending[i].id },
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
  // Episodic and provisional entries are excluded from consolidation — they're short-lived

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
          content: `You are normalizing a fact store. Given a numbered list of facts, return a cleaned version.

Step 1 — Split: if any entry contains multiple distinct facts bundled together (e.g. joined by "and", "also", "while", or a comma listing unrelated things), split each into separate atomic entries. One fact per entry.

Step 2 — Deduplicate: drop any entry that is fully covered by another.

Step 3 — Merge: only merge entries that are about the exact same specific thing (e.g. two entries about the same person's job). Do NOT merge entries just because they share a broad theme like "music" or "sports".

Rules:
- Each output entry should express exactly one fact
- Preserve all unique information — do not lose anything
- Keep entries short and specific
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
  // Preserve episodic and provisional entries — they're not consolidated
  const preserved = entries.filter((e) => e.category === "episodic" || e.category === "provisional");

  const newEntries = [
    ...consolidatedFacts.map((text) => ({
      id: makeId(),
      text,
      category: "fact",
      confidence: 1.0,
      source: "consolidation",
      lifespan: "permanent",
      expiresAt: null,
      scope: "global",
      embedded: false,
      addedBy: "consolidation",
      addedAt: now,
      updatedAt: null,
    })),
    ...consolidatedDirectives.map((text) => ({
      id: makeId(),
      text,
      category: "directive",
      confidence: 1.0,
      source: "consolidation",
      lifespan: "permanent",
      expiresAt: null,
      scope: "global",
      embedded: false,
      addedBy: "consolidation",
      addedAt: now,
      updatedAt: null,
    })),
    ...preserved,
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
