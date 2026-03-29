/**
 * entity-summary.js — shared entity summary builder
 *
 * Used by both memory-store-pg.js (inline rebuild on new memories) and
 * maintenance.js (bulk rebuild on worker startup).
 *
 * Intentionally avoids importing persona/loader.js so it can be safely
 * imported from the worker image.
 */

import OpenAI from "openai";
import { getPool } from "./db-client.js";

const openai = new OpenAI();

const ENTITY_SUMMARY_SYSTEM = `You are summarising what a persona knows about a person in their friend group. Write 2–3 sentences covering who they are, key facts, and their relationship to the group. Be specific and factual — only include what's in the facts provided. Do not invent details.`;

const MEMORY_FETCH_SQL = `
  SELECT text FROM memories
  WHERE persona_id = $1
    AND person_name ILIKE $2
    AND category = 'memory'
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY confidence DESC, last_accessed_at DESC NULLS LAST
  LIMIT 30
`;

const ENTITY_UPDATE_SQL = `
  UPDATE entities
  SET summary = $1, summary_updated_at = now(), memory_count = $2
  WHERE persona_id = $3 AND name ILIKE $4
`;

/**
 * Fetch memories for a person, generate an LLM summary, and update the entities table.
 * Returns the summary string, or undefined if the person has no memories.
 *
 * @param {import('pg').Pool} pool
 * @param {string} personaId
 * @param {string} personName
 * @returns {Promise<string|undefined>}
 */
export async function buildEntitySummary(pool, personaId, personName) {
  const { rows } = await pool.query(MEMORY_FETCH_SQL, [personaId, personName]);
  if (rows.length === 0) return undefined;

  const factList = rows.map((r) => `- ${r.text}`).join("\n");
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: "system", content: ENTITY_SUMMARY_SYSTEM },
      { role: "user", content: `Person: ${personName}\n\nKnown facts:\n${factList}` },
    ],
  });
  const summary = response.choices[0].message.content.trim();
  await pool.query(ENTITY_UPDATE_SQL, [summary, rows.length, personaId, personName]);
  return summary;
}

/**
 * Rebuild the summary for a single named entity.
 * Convenience wrapper that uses the shared pool.
 *
 * @param {string} personaId
 * @param {string} personName
 */
export async function rebuildEntitySummary(personaId, personName) {
  const pool = getPool();
  try {
    const summary = await buildEntitySummary(pool, personaId, personName);
    if (summary !== undefined) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_summary_rebuilt", personaId, personName }));
    }
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_summary_error", personaId, personName, error: err.message }));
  }
}

/**
 * Rebuild summaries for all entities that have no summary yet.
 * Designed to run once after migration or on-demand via a worker job.
 *
 * @param {string} personaId
 */
export async function rebuildStaleEntities(personaId) {
  const pool = getPool();

  const { rows: stale } = await pool.query(
    `SELECT name FROM entities
     WHERE persona_id = $1 AND summary IS NULL
     ORDER BY memory_count DESC`,
    [personaId]
  );

  if (stale.length === 0) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_backfill_skip", personaId, reason: "all entities have summaries" }));
    return;
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_backfill_start", personaId, count: stale.length }));

  for (const { name } of stale) {
    try {
      const summary = await buildEntitySummary(pool, personaId, name);
      if (summary !== undefined) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_backfill_done", personaId, name }));
      }
    } catch (err) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_backfill_error", personaId, name, error: err.message }));
    }
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_backfill_complete", personaId, count: stale.length }));
}
