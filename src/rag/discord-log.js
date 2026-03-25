/**
 * discord-log.js — capture the real persona's Discord messages as training examples
 *
 * When the real person posts in Discord, bot.js calls logPersonaMessage() with the
 * conversation context before their message and their reply text. Entries are
 * stored in data/discord-pairs.json and lazily embedded into data/index-discord/.
 *
 * At query time, retrieveDiscord() returns the most semantically similar past
 * exchanges to inject as additional style examples alongside WhatsApp RAG.
 */

import "dotenv/config";
import fs from "fs";
import OpenAI from "openai";
import { LocalIndex } from "vectra";
import { getPersona } from "../persona/loader.js";

const persona = getPersona();
const pairsPath = persona.paths.discordPairsJson;
const indexPath = persona.paths.indexDiscord;

const MAX_ENTRIES = 500;

const openai = new OpenAI();
const index = new LocalIndex(indexPath);

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function makeId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `dc_${Date.now()}_${rand}`;
}

function load() {
  if (!fs.existsSync(pairsPath)) return [];
  return JSON.parse(fs.readFileSync(pairsPath, "utf8"));
}

function save(entries) {
  fs.writeFileSync(pairsPath, JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// Public: log a persona message
// ---------------------------------------------------------------------------

/**
 * Record a real persona Discord message as a context-response pair.
 * context: the N prior messages formatted as "Name: text\nName: text\n..."
 * response: the persona's reply formatted as "Name: text"
 */
export function logPersonaMessage(context, response) {
  const entries = load();

  entries.push({
    id: makeId(),
    timestamp: new Date().toISOString(),
    inputContext: context,
    response,
    windowText: context ? `${context}\n${response}` : response,
    embedded: false,
  });

  // Rolling cap — drop oldest entries first
  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  save(entries);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "discord_logged", total: entries.length, response: response.slice(0, 60) }));
}

// ---------------------------------------------------------------------------
// Public: lazy embedding
// ---------------------------------------------------------------------------

/**
 * Embed any unembedded entries into the discord index.
 * No-op if nothing is pending. Call at the start of each bot query.
 */
export async function embedPendingDiscord() {
  const entries = load();
  const pending = entries.filter((e) => e.embedded === false);

  if (pending.length === 0) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "discord_embed_check", pending: 0 }));
    return 0;
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "discord_embed_start", pending: pending.length }));

  if (!(await index.isIndexCreated())) {
    await index.createIndex();
  }

  const embResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: pending.map((e) => e.windowText),
  });

  await index.beginUpdate();
  for (let i = 0; i < pending.length; i++) {
    await index.upsertItem({
      id: pending[i].id,
      vector: embResponse.data[i].embedding,
      metadata: { id: pending[i].id },
    });
  }
  await index.endUpdate();

  for (const entry of pending) {
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx !== -1) entries[idx].embedded = true;
  }
  save(entries);

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "discord_embedded", count: pending.length }));
  return pending.length;
}

// ---------------------------------------------------------------------------
// Public: retrieve
// ---------------------------------------------------------------------------

/**
 * Retrieve the top K most similar Discord conversation pairs for a query.
 * embedPendingDiscord() should be called before this.
 * Returns entries with { inputContext, response } for injection into the prompt.
 */
export async function retrieveDiscord(query, k = 3) {
  if (!(await index.isIndexCreated())) return [];

  const entries = load();
  if (entries.length === 0) return [];

  const embResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: [query],
  });
  const vector = embResponse.data[0].embedding;

  const results = await index.queryItems(vector, k);
  const entryById = new Map(entries.map((e) => [e.id, e]));

  const retrieved = results.map((r) => entryById.get(r.item.metadata.id)).filter(Boolean);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "discord_retrieve", count: retrieved.length, examples: retrieved.map((e) => e.response.slice(0, 60)) }));
  return retrieved;
}
