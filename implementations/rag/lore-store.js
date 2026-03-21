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
    if (!Object.prototype.hasOwnProperty.call(entry, "person")) { entry.person = null; dirty = true; }
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

/**
 * Decay confidence on bot-inferred provisional entries based on age.
 * Linear decay from 0.6 (day 0) to 0.3 (day 30). Entries at or below 0.3 are pruned.
 * Call at startup after pruneExpired(). Returns { decayed, pruned }.
 */
export function applyDecay() {
  const entries = load();
  const now = new Date();
  const kept = [];
  let decayed = 0;
  let pruned = 0;

  for (const entry of entries) {
    if (entry.category !== "provisional" || entry.source !== "bot-inferred") {
      kept.push(entry);
      continue;
    }

    let ageInDays = 0;
    try {
      const addedAt = new Date(entry.addedAt);
      if (!isNaN(addedAt.getTime())) {
        ageInDays = (now - addedAt) / (1000 * 60 * 60 * 24);
      }
    } catch { /* treat as age 0 */ }

    const newConfidence = Math.max(0.3, 0.6 - (ageInDays / 30) * 0.3);

    if (newConfidence <= 0.3) {
      pruned++;
      continue;
    }

    if (Math.abs(newConfidence - entry.confidence) > 0.001) {
      entry.confidence = Math.round(newConfidence * 1000) / 1000;
      decayed++;
    }
    kept.push(entry);
  }

  if (decayed > 0 || pruned > 0) {
    save(kept);
    console.log(JSON.stringify({ ts: now.toISOString(), stage: "lore_decay", decayed, pruned }));
  }

  return { decayed, pruned };
}

// ---------------------------------------------------------------------------
// LLM: classify
// ---------------------------------------------------------------------------

const SPLIT_OR_CLASSIFY_SYSTEM = `You process a memory entry for a fact store. Break it into one or more categorized parts.

Categories:
- "directive" — a behavioral rule for the bot (how it should speak or respond). Examples: "Don't use the word delve", "Never bring up X topic"
- "fact" — a permanent memory, lore, personal detail, or event. Default for most entries.
- "episodic" — explicitly temporary information. Use when the input contains phrases like "for now", "today", "tonight", "tomorrow", "this week", "this weekend", "next week", "this month", "next month", "next year", "temporarily", "just for today", or other clear short-term signals.

Return a JSON object with a "parts" array. Each part has "text", "category", and "person" (the first name of the person the fact is about, or null if not person-specific — always null for directives).
If the entry is a single thing, return one part. If it mixes facts and directives, split them into separate parts — one per distinct fact or rule.

{"parts": [{"text": "...", "category": "fact"|"directive"|"episodic", "person": "<first name or null>"}, ...]}

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
        person: typeof p.person === "string" && p.person.length > 0 ? p.person : null,
      }));
    }
    return [{ text, category: "fact", person: null }];
  } catch {
    return [{ text, category: "fact", person: null }]; // default: never lose an entry
  }
}

// ---------------------------------------------------------------------------
// LLM: coalesce
// ---------------------------------------------------------------------------

const COALESCE_SYSTEM = `You manage a compact fact store. Given an existing list of facts and a new candidate fact, decide what to do.

Respond with a JSON object — no markdown, no explanation, just the JSON:

If the new fact is already fully covered by an existing entry, return the index (0-based) of that entry:
{"action":"skip","index":<n>}

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
// LLM: contradiction check
// ---------------------------------------------------------------------------

const CONTRADICTION_SYSTEM = `You manage a fact store. Given a new fact and a list of existing facts, identify if any existing fact directly contradicts the new fact — meaning both cannot be true at the same time.

Do NOT flag facts that are similar, overlapping, complementary, or just updates. Only flag true logical contradictions.

Examples of contradictions:
- "Nigel lives in Seattle" vs "Nigel lives in Boston" ✓
- "Dave is coming to the game" vs "Dave is not coming to the game" ✓

Not contradictions:
- "Nigel went to Vermont last year" vs "Nigel is going to Vermont next month" (different times)
- "Dave likes golf" vs "Dave is bad at golf" (can both be true)

Return JSON only:
{"contradicts": true, "index": <n>}   — if existing fact at index n directly contradicts the new fact
{"contradicts": false}                 — if no contradiction exists`;

async function checkContradiction(newFact, candidates) {
  if (candidates.length === 0) return { contradicts: false };

  const list = candidates.map((e, i) => `${i}: ${e.text}`).join("\n");
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CONTRADICTION_SYSTEM },
        { role: "user", content: `EXISTING FACTS:\n${list}\n\nNEW FACT:\n${newFact}` },
      ],
    });
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { contradicts: false };
  }
}

// ---------------------------------------------------------------------------
// Internal: pre-filter candidates by vector similarity
// ---------------------------------------------------------------------------

async function preFilterCandidates(text, candidates, n = 20) {
  if (candidates.length <= n) return candidates;
  if (!(await loreIndex.isIndexCreated())) return candidates.slice(0, n);

  try {
    const embResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: [text],
    });
    const results = await loreIndex.queryItems(embResponse.data[0].embedding, n * 2);

    const candidateById = new Map(candidates.map((e) => [e.id, e]));
    const filtered = results
      .map((r) => candidateById.get(r.item.metadata.id))
      .filter(Boolean)
      .slice(0, n);

    return filtered.length > 0 ? filtered : candidates.slice(0, n);
  } catch {
    return candidates.slice(0, n);
  }
}

// ---------------------------------------------------------------------------
// Temporal TTL detection
// ---------------------------------------------------------------------------

/**
 * Detect temporal references in text and return an appropriate expiresAt ISO string.
 * Returns null if no temporal reference is found.
 */
function detectTemporalExpiry(text, now = new Date()) {
  const t = text.toLowerCase();

  if (/\b(today|tonight|this morning|this afternoon|this evening)\b/.test(t)) {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }

  if (/\btomorrow\b/.test(t)) {
    const end = new Date(now);
    end.setDate(end.getDate() + 1);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }

  if (/\bthis weekend\b/.test(t)) {
    const end = new Date(now);
    const daysToSunday = ((7 - end.getDay()) % 7) || 7;
    end.setDate(end.getDate() + daysToSunday);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }

  if (/\bthis week\b/.test(t)) {
    const end = new Date(now);
    const daysToSunday = ((7 - end.getDay()) % 7) || 7;
    end.setDate(end.getDate() + daysToSunday);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }

  if (/\bnext week\b/.test(t)) {
    const end = new Date(now);
    const daysToSunday = ((7 - end.getDay()) % 7) || 7;
    end.setDate(end.getDate() + daysToSunday + 7);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }

  if (/\bthis month\b/.test(t)) {
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return end.toISOString();
  }

  if (/\bnext month\b/.test(t)) {
    const end = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
    return end.toISOString();
  }

  if (/\bnext year\b/.test(t)) {
    const end = new Date(now.getFullYear() + 1, 11, 31, 23, 59, 59, 999);
    return end.toISOString();
  }

  const inDays = t.match(/\bin (\d+) days?\b/);
  if (inDays) {
    const end = new Date(now);
    end.setDate(end.getDate() + parseInt(inDays[1]));
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }

  const inWeeks = t.match(/\bin (\d+) weeks?\b/);
  if (inWeeks) {
    const end = new Date(now);
    end.setDate(end.getDate() + parseInt(inWeeks[1]) * 7);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }

  const inMonths = t.match(/\bin (\d+) months?\b/);
  if (inMonths) {
    const end = new Date(now);
    end.setMonth(end.getMonth() + parseInt(inMonths[1]));
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }

  return null;
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
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_classified", parts: parts.map((p) => ({ category: p.category, person: p.person, text: p.text.slice(0, 60) })) }));

  if (parts.length > 1) {
    await Promise.all(parts.map((p) => addSingle(p.text, p.category, addedBy, p.person)));
    return { action: "split" };
  }

  return addSingle(parts[0].text, parts[0].category, addedBy, parts[0].person);
}

async function addSingle(text, category, addedBy, person = null) {
  const entries = load();
  const sameCat = entries.filter((e) => e.category === category);

  if (category === "directive" && sameCat.length >= DIRECTIVE_CAP) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_capped", category, count: sameCat.length }));
    return { action: "capped", category };
  }

  const candidates = category === "directive" ? sameCat : await preFilterCandidates(text, sameCat);
  const result = await coalesce(text, candidates);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_coalesce", category, person, text: text.slice(0, 60), candidateCount: candidates.length, result }));

  if (result.action === "skip") {
    return { action: "skipped", category };
  }

  if (result.action === "merge" && typeof result.index === "number" && candidates[result.index]) {
    const targetId = candidates[result.index].id;
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
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_merged", category, person, id: targetId, text: result.merged.slice(0, 80) }));
      return { action: "merged", category };
    }
  }

  // coalesce returned "add" — check for contradictions before writing
  if (category === "fact" || category === "episodic") {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_contradiction_check", category, person, candidateCount: candidates.length, text: text.slice(0, 60) }));
    const contradiction = await checkContradiction(text, candidates);
    if (contradiction.contradicts && typeof contradiction.index === "number" && candidates[contradiction.index]) {
      const targetId = candidates[contradiction.index].id;
      const actualIndex = entries.findIndex((e) => e.id === targetId);
      if (actualIndex !== -1) {
        const oldEntry = entries[actualIndex];
        entries[actualIndex] = {
          ...oldEntry,
          text,
          person,
          embedded: false,
          updatedBy: addedBy,
          updatedAt: new Date().toISOString(),
        };
        save(entries);
        console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_contradiction", category, person, id: targetId, old: oldEntry.text.slice(0, 80), new: text.slice(0, 80) }));
        return { action: "merged", category, contradiction: true };
      }
    } else {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_contradiction_clear", category, person, text: text.slice(0, 60) }));
    }
  }

  const now = new Date();
  const temporalExpiry = detectTemporalExpiry(text, now);
  const defaultEpisodicExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const expiresAt = temporalExpiry ?? (category === "episodic" ? defaultEpisodicExpiry : null);
  const isTemporalFact = temporalExpiry && category !== "episodic";
  const confidenceByCategory = { directive: 1.0, fact: 1.0, episodic: 0.8, provisional: 0.6 };
  const lifespanByCategory = { directive: "permanent", fact: "permanent", episodic: "temporary", provisional: "long-lived" };
  const confidence = temporalExpiry ? 1.0 : (confidenceByCategory[category] ?? 1.0);
  const lifespan = (isTemporalFact || category === "episodic") ? "temporary" : (lifespanByCategory[category] ?? "permanent");

  entries.push({
    id: makeId(),
    text,
    person,
    category,
    confidence,
    source: "explicit",
    lifespan,
    expiresAt,
    scope: "global",
    embedded: false,
    addedBy,
    addedAt: now.toISOString(),
    updatedAt: null,
  });
  save(entries);
  console.log(JSON.stringify({ ts: now.toISOString(), stage: "lore_added", category, person, confidence, lifespan, expiresAt, text: text.slice(0, 80) }));
  if (temporalExpiry) console.log(JSON.stringify({ ts: now.toISOString(), stage: "lore_temporal", category, person, expiresAt: temporalExpiry, text: text.slice(0, 80) }));
  return { action: "added", category, temporal: !!temporalExpiry };
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
  const pending = entries.filter((e) => (e.category === "fact" || e.category === "episodic" || e.category === "provisional") && e.embedded === false);

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

  const queryLower = query.toLowerCase();
  const scored = results
    .map((r) => ({ entry: entryById.get(r.item.metadata.id), score: r.score }))
    .filter(({ entry }) => Boolean(entry))
    .sort((a, b) => (b.score * b.entry.confidence) - (a.score * a.entry.confidence))
    .map(({ entry }) => entry);

  // Boost person-tagged entries whose person appears in the query
  const personMatches = scored.filter((e) => e.person && queryLower.includes(e.person.toLowerCase()));
  const others = scored.filter((e) => !e.person || !queryLower.includes(e.person.toLowerCase()));
  const retrieved = [...personMatches, ...others];

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_retrieve", count: retrieved.length, personBoosted: personMatches.length, facts: retrieved.map((e) => ({ text: e.text.slice(0, 60), person: e.person })) }));
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
// Public: deduplicateLore — one-time post-deploy cleanup of legacy duplicates
// ---------------------------------------------------------------------------

/**
 * Find and resolve near-duplicate fact/episodic entries using vector similarity + coalesce.
 * Processes entries oldest-first (treating older entries as canonical).
 * Only runs coalesce on pairs with similarity score > DEDUP_THRESHOLD — avoids
 * unnecessary API calls for entries that are clearly distinct.
 * Idempotent — no-op once the store is clean (no pairs above threshold).
 * Call at startup after attributePersons(). Returns { merged, removed }.
 */
export async function deduplicateLore() {
  const DEDUP_THRESHOLD = 0.85;

  if (!(await loreIndex.isIndexCreated())) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "dedup_skip", reason: "no_index" }));
    return { merged: 0, removed: 0 };
  }

  const allEntries = load();
  const targets = allEntries
    .filter((e) => (e.category === "fact" || e.category === "episodic") && e.embedded)
    .sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt)); // oldest = canonical

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "dedup_start", total: targets.length }));
  if (targets.length < 2) return { merged: 0, removed: 0 };

  // Batch-embed all target texts in one API call
  const embResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: targets.map((e) => e.text),
  });
  const embeddingById = new Map(targets.map((e, i) => [e.id, embResponse.data[i].embedding]));

  const removedIds = new Set();
  const updates = new Map(); // id -> merged text
  let merged = 0;
  let removed = 0;

  for (let i = 1; i < targets.length; i++) {
    const entry = targets[i];
    if (removedIds.has(entry.id)) continue;

    // Find similar entries among older (canonical) entries via vector query
    const embedding = embeddingById.get(entry.id);
    if (!embedding) continue;

    const results = await loreIndex.queryItems(embedding, 10);
    const canonicalById = new Map(targets.slice(0, i).filter((e) => !removedIds.has(e.id)).map((e) => [e.id, e]));

    const candidates = results
      .filter((r) => r.score >= DEDUP_THRESHOLD && r.item.metadata.id !== entry.id && canonicalById.has(r.item.metadata.id))
      .map((r) => canonicalById.get(r.item.metadata.id));

    if (candidates.length === 0) continue;

    const result = await coalesce(entry.text, candidates);
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "dedup_coalesce", action: result.action, text: entry.text.slice(0, 60), candidateCount: candidates.length }));

    if (result.action === "skip") {
      removedIds.add(entry.id);
      removed++;
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "dedup_removed", id: entry.id, text: entry.text.slice(0, 60) }));
    } else if (result.action === "merge" && typeof result.index === "number" && candidates[result.index]) {
      const target = candidates[result.index];
      updates.set(target.id, result.merged);
      removedIds.add(entry.id);
      merged++;
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "dedup_merged", keepId: target.id, removeId: entry.id, merged: result.merged.slice(0, 60) }));
    }
  }

  if (removedIds.size === 0 && updates.size === 0) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "dedup_done", merged: 0, removed: 0 }));
    return { merged: 0, removed: 0 };
  }

  // Apply all changes in one write
  const current = load();
  const cleaned = current
    .filter((e) => !removedIds.has(e.id))
    .map((e) => updates.has(e.id) ? { ...e, text: updates.get(e.id), embedded: false, updatedAt: new Date().toISOString() } : e);
  save(cleaned);

  // Remove stale vectors for removed entries
  for (const id of removedIds) {
    try { await loreIndex.deleteItem(id); } catch { /* ignore */ }
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "dedup_done", merged, removed, totalCleaned: merged + removed }));
  return { merged, removed };
}

// ---------------------------------------------------------------------------
// Public: attributePersons — one-time post-deploy enrichment
// ---------------------------------------------------------------------------

const ATTRIBUTE_SYSTEM = `You are attributing person names to a list of facts from a Discord friend group.

For each fact, identify the first name of the person the fact is primarily about.
If the fact is about multiple people equally, pick the first named.
If the fact is not primarily about a specific named person, return null.

Return a JSON object with an "attributions" array of exactly the same length as the input:
{"attributions": [<"first name" or null>, ...]}
JSON only, no markdown.`;

/**
 * Attribute a `person` field to all existing lore entries that don't have one.
 * Skips directives (always null). Batches LLM calls. Saves after each batch.
 * Idempotent — no-op if all entries already have person set.
 * Call once at startup after pruneExpired / applyDecay.
 * Returns { total, attributed, skipped }.
 */
export async function attributePersons() {
  const BATCH_SIZE = 30;
  const entries = load();

  const targets = entries.filter(
    (e) => !Object.prototype.hasOwnProperty.call(e, "person") || e.person === null
  ).filter((e) => e.category !== "directive");

  const total = targets.length;
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "attribute_persons_start", total, entryCount: entries.length }));

  if (total === 0) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "attribute_persons_done", total: 0, attributed: 0, skipped: 0 }));
    return { total: 0, attributed: 0, skipped: 0 };
  }

  let attributed = 0;
  let skipped = 0;
  const batches = Math.ceil(total / BATCH_SIZE);

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "attribute_persons_batch_start", batch: batchNum, of: batches, size: batch.length }));

    let attributions;
    try {
      const list = batch.map((e, j) => `${j}: ${e.text}`).join("\n");
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ATTRIBUTE_SYSTEM },
          { role: "user", content: list },
        ],
      });
      const result = JSON.parse(response.choices[0].message.content);
      attributions = Array.isArray(result.attributions) ? result.attributions : batch.map(() => null);
    } catch (err) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "attribute_persons_batch_error", batch: batchNum, message: err.message }));
      attributions = batch.map(() => null);
    }

    // Reload to get freshest entries (in case something wrote between batches)
    const current = load();
    const byId = new Map(current.map((e) => [e.id, e]));
    let batchAttributed = 0;
    let batchSkipped = 0;

    for (let j = 0; j < batch.length; j++) {
      const person = typeof attributions[j] === "string" && attributions[j].length > 0 ? attributions[j] : null;
      const entry = byId.get(batch[j].id);
      if (entry) {
        entry.person = person;
        if (person) { batchAttributed++; attributed++; } else { batchSkipped++; skipped++; }
      }
    }

    save([...byId.values()]);
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "attribute_persons_batch_done", batch: batchNum, of: batches, attributed: batchAttributed, skipped: batchSkipped, sample: batch.slice(0, 3).map((e, j) => ({ person: attributions[j] ?? null, text: e.text.slice(0, 50) })) }));
  }

  // Summary by person
  const final = load();
  const byPerson = {};
  for (const e of final) {
    if (e.person) byPerson[e.person] = (byPerson[e.person] || 0) + 1;
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "attribute_persons_done", total, attributed, skipped, byPerson }));
  return { total, attributed, skipped };
}

// ---------------------------------------------------------------------------
// Public: implicit extraction
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `You are a memory assistant for a Discord friend group. Given a short conversation snippet, extract anything worth remembering about the people involved.

Extract broadly — personal facts AND conversational signals:
- Personal facts: job changes, moves, relationships, health, major events
- Concrete upcoming plans (trips, meetups, activities with some specificity)
- Opinions, preferences, and strong takes on anything — sports, politics, games, food, media, news
- Recurring interests, hobbies, or things they care about
- Patterns in who someone is ("always", "never", "hates when", "loves that")

Do NOT extract:
- One-word reactions, filler, or pure acknowledgment ("lol", "yeah", "nice")
- Jokes that only work in context
- Messages directed at the bot — questions, requests, or prompts asking the bot for something ("what should I do", "what do you think", "who would win")
- Bot commands or meta-conversation about the bot
- Vague speculation ("might", "probably", "maybe")
- Questions without clear answers in the conversation

Write facts in third person, concisely. Include the person's name in the fact text.
Return a JSON object: {"facts": [{"text": "...", "person": "<first name of person the fact is about, or null>"}, ...]}
Return {"facts": []} if nothing is worth capturing.
No markdown, JSON only.`;

const PROVISIONAL_EXPIRY_DAYS = 30;

/**
 * Extract memory-worthy content from a conversation snippet.
 * Returns an array of {text, person} objects (may be empty).
 * Handles both old string format and new object format defensively.
 */
export async function extractImplicit(conversationText) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: conversationText },
      ],
    });
    const result = JSON.parse(response.choices[0].message.content);
    if (!Array.isArray(result.facts)) return [];
    return result.facts
      .map((f) => {
        if (typeof f === "string") return { text: f, person: null }; // back-compat
        if (f && typeof f.text === "string" && f.text.length > 0) {
          return { text: f.text, person: typeof f.person === "string" && f.person.length > 0 ? f.person : null };
        }
        return null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Store an implicitly extracted fact.
 *
 * - Matches existing fact        → skip (already known)
 * - Matches existing provisional → promote provisional to permanent fact
 * - No match                     → add as provisional (expires in 30 days)
 *
 * Returns { action: 'known' | 'promoted' | 'added' }
 */
export async function addImplicit(text, source = "bot-inferred", person = null) {
  const entries = load();

  // Check against existing facts — skip if already known
  const facts = entries.filter((e) => e.category === "fact");
  if (facts.length > 0) {
    const factCandidates = await preFilterCandidates(text, facts);
    const factResult = await coalesce(text, factCandidates);
    if (factResult.action === "skip" || factResult.action === "merge") {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "implicit_skip", reason: "known_fact", person, text: text.slice(0, 80) }));
      return { action: "known" };
    }
  }

  // Check against existing provisionals — promote if matched
  const provisionals = entries.filter((e) => e.category === "provisional");
  if (provisionals.length > 0) {
    const provCandidates = await preFilterCandidates(text, provisionals);
    const provResult = await coalesce(text, provCandidates);
    if (
      (provResult.action === "skip" || provResult.action === "merge") &&
      typeof provResult.index === "number" &&
      provCandidates[provResult.index]
    ) {
      const target = provCandidates[provResult.index];
      const promotedText = provResult.action === "merge" ? provResult.merged : target.text;
      const actualIndex = entries.findIndex((e) => e.id === target.id);
      if (actualIndex !== -1) {
        entries[actualIndex] = {
          ...entries[actualIndex],
          text: promotedText,
          category: "fact",
          confidence: 1.0,
          lifespan: "permanent",
          expiresAt: null,
          embedded: false,
          updatedAt: new Date().toISOString(),
        };
        save(entries);
        console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "implicit_promoted", id: target.id, person, text: promotedText.slice(0, 80) }));
        return { action: "promoted" };
      }
    }
  }

  // New — store as provisional
  const now = new Date();
  const temporalExpiry = detectTemporalExpiry(text, now);
  const defaultExpiry = new Date(now.getTime() + PROVISIONAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  entries.push({
    id: makeId(),
    text,
    person,
    category: "provisional",
    confidence: temporalExpiry ? 1.0 : 0.6,
    source,
    lifespan: temporalExpiry ? "temporary" : "long-lived",
    expiresAt: temporalExpiry ?? defaultExpiry,
    scope: "global",
    embedded: false,
    addedBy: "bot",
    addedAt: now.toISOString(),
    updatedAt: null,
  });
  save(entries);
  if (temporalExpiry) console.log(JSON.stringify({ ts: now.toISOString(), stage: "lore_temporal", category: "provisional", person, source, expiresAt: temporalExpiry, text: text.slice(0, 80) }));
  console.log(JSON.stringify({ ts: now.toISOString(), stage: "implicit_added", person, confidence: temporalExpiry ? 1.0 : 0.6, expiresAt: temporalExpiry ?? defaultExpiry, text: text.slice(0, 80) }));
  return { action: "added", temporal: !!temporalExpiry };
}

/**
 * Store a user-asserted fact as provisional with low confidence (0.3).
 * Follows the same promotion pipeline as addImplicit — matches existing
 * facts (skip) or provisionals (promote), otherwise stores as provisional.
 * Returns { action: 'known' | 'promoted' | 'added' }
 */
export async function addUserAsserted(text, addedBy = "unknown") {
  const entries = load();

  const facts = entries.filter((e) => e.category === "fact");
  if (facts.length > 0) {
    const factCandidates = await preFilterCandidates(text, facts);
    const factResult = await coalesce(text, factCandidates);
    if (factResult.action === "skip" || factResult.action === "merge") {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "user_asserted_skip", reason: "known_fact", addedBy, text: text.slice(0, 80) }));
      return { action: "known" };
    }
  }

  const provisionals = entries.filter((e) => e.category === "provisional");
  if (provisionals.length > 0) {
    const provCandidates = await preFilterCandidates(text, provisionals);
    const provResult = await coalesce(text, provCandidates);
    if (
      (provResult.action === "skip" || provResult.action === "merge") &&
      typeof provResult.index === "number" &&
      provCandidates[provResult.index]
    ) {
      const target = provCandidates[provResult.index];
      const promotedText = provResult.action === "merge" ? provResult.merged : target.text;
      const actualIndex = entries.findIndex((e) => e.id === target.id);
      if (actualIndex !== -1) {
        entries[actualIndex] = {
          ...entries[actualIndex],
          text: promotedText,
          category: "fact",
          confidence: 1.0,
          lifespan: "permanent",
          expiresAt: null,
          embedded: false,
          updatedAt: new Date().toISOString(),
        };
        save(entries);
        console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "user_asserted_promoted", id: target.id, addedBy, text: promotedText.slice(0, 80) }));
        return { action: "promoted" };
      }
    }
  }

  const now = new Date();
  const temporalExpiry = detectTemporalExpiry(text, now);
  const defaultExpiry = new Date(now.getTime() + PROVISIONAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  entries.push({
    id: makeId(),
    text,
    person: null,
    category: "provisional",
    confidence: temporalExpiry ? 1.0 : 0.3,
    source: "user-asserted",
    lifespan: temporalExpiry ? "temporary" : "long-lived",
    expiresAt: temporalExpiry ?? defaultExpiry,
    scope: "global",
    embedded: false,
    addedBy,
    addedAt: now.toISOString(),
    updatedAt: null,
  });
  save(entries);
  if (temporalExpiry) console.log(JSON.stringify({ ts: now.toISOString(), stage: "lore_temporal", category: "provisional", person: null, source: "user-asserted", expiresAt: temporalExpiry, text: text.slice(0, 80) }));
  console.log(JSON.stringify({ ts: now.toISOString(), stage: "user_asserted_added", addedBy, confidence: temporalExpiry ? 1.0 : 0.3, expiresAt: temporalExpiry ?? defaultExpiry, text: text.slice(0, 80) }));
  return { action: "added", temporal: !!temporalExpiry };
}
