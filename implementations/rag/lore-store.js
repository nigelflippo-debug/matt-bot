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

  const candidates = category === "directive" ? sameCat : await preFilterCandidates(text, sameCat);
  const result = await coalesce(text, candidates);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "lore_coalesce", category, candidateCount: candidates.length, result }));

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
      return { action: "merged", category };
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

  const retrieved = results
    .map((r) => ({ entry: entryById.get(r.item.metadata.id), score: r.score }))
    .filter(({ entry }) => Boolean(entry))
    .sort((a, b) => (b.score * b.entry.confidence) - (a.score * a.entry.confidence))
    .map(({ entry }) => entry);

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
- Bot commands or meta-conversation about the bot
- Vague speculation ("might", "probably", "maybe")
- Questions without clear answers in the conversation

Write facts in third person, concisely. Include the person's name.
Return a JSON object: {"facts": ["...", ...]}
Return {"facts": []} if nothing is worth capturing.
No markdown, JSON only.`;

const PROVISIONAL_EXPIRY_DAYS = 30;

/**
 * Extract memory-worthy content from a conversation snippet.
 * Returns an array of fact strings (may be empty).
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
    return Array.isArray(result.facts)
      ? result.facts.filter((f) => typeof f === "string" && f.length > 0)
      : [];
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
export async function addImplicit(text, source = "bot-inferred") {
  const entries = load();

  // Check against existing facts — skip if already known
  const facts = entries.filter((e) => e.category === "fact");
  if (facts.length > 0) {
    const factCandidates = await preFilterCandidates(text, facts);
    const factResult = await coalesce(text, factCandidates);
    if (factResult.action === "skip" || factResult.action === "merge") {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "implicit_skip", reason: "known_fact", text: text.slice(0, 80) }));
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
        console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "implicit_promoted", id: target.id, text: promotedText.slice(0, 80) }));
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
  console.log(JSON.stringify({ ts: now.toISOString(), stage: "implicit_added", text: text.slice(0, 80) }));
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
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "user_asserted_skip", reason: "known_fact", text: text.slice(0, 80) }));
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
        console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "user_asserted_promoted", id: target.id, text: promotedText.slice(0, 80) }));
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
  console.log(JSON.stringify({ ts: now.toISOString(), stage: "user_asserted_added", addedBy, text: text.slice(0, 80) }));
  return { action: "added", temporal: !!temporalExpiry };
}
