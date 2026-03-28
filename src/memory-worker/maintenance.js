/**
 * maintenance.js — scheduled maintenance passes for the memory-worker
 *
 * runDecay()              — weekly: decay confidence on stale bot-inferred memories
 * runPruning()            — daily:  delete expired and never-accessed stale memories
 * rebuildStaleEntities()  — one-time/on-demand: build summaries for entities with none
 */

import OpenAI from "openai";
import { getPool } from "../rag/db-client.js";

const openai = new OpenAI();

/**
 * Decay confidence on bot-inferred memories not accessed in 7+ days.
 * Confidence = GREATEST(0.1, confidence * 0.9) per pass.
 */
export async function runDecay() {
  const pool = getPool();
  try {
    const { rowCount } = await pool.query(
      `UPDATE memories
       SET confidence = GREATEST(0.1, confidence * 0.9),
           updated_at = now()
       WHERE source = 'bot-inferred'
         AND last_accessed_at < now() - interval '7 days'`
    );
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "decay_done", updated: rowCount }));
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "decay_error", error: err.message }));
  }
}

/**
 * Delete expired memories and never-accessed stale bot-inferred memories.
 * - Expired: expires_at < now()
 * - Stale: source='bot-inferred', last_accessed_at IS NULL, added_at > 30 days ago
 */
export async function runPruning() {
  const pool = getPool();
  try {
    const { rowCount: expired } = await pool.query(
      `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < now()`
    );
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "prune_expired", deleted: expired }));
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "prune_expired_error", error: err.message }));
  }

  try {
    const { rowCount: stale } = await pool.query(
      `DELETE FROM memories
       WHERE source = 'bot-inferred'
         AND last_accessed_at IS NULL
         AND added_at < now() - interval '30 days'`
    );
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "prune_stale", deleted: stale }));
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "prune_stale_error", error: err.message }));
  }
}

/**
 * Rebuild summaries for all entities that have no summary yet.
 * Designed to run once after migration or on-demand via a worker job.
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
    const { rows } = await pool.query(
      `SELECT text FROM memories
       WHERE persona_id = $1
         AND person_name ILIKE $2
         AND category = 'memory'
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY confidence DESC, last_accessed_at DESC NULLS LAST
       LIMIT 30`,
      [personaId, name]
    );
    if (rows.length === 0) continue;

    const factList = rows.map((r) => `- ${r.text}`).join("\n");
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: `You are summarising what a persona knows about a person in their friend group. Write 2–3 sentences covering who they are, key facts, and their relationship to the group. Be specific and factual — only include what's in the facts provided. Do not invent details.`,
          },
          { role: "user", content: `Person: ${name}\n\nKnown facts:\n${factList}` },
        ],
      });
      const summary = response.choices[0].message.content.trim();
      await pool.query(
        `UPDATE entities SET summary = $1, summary_updated_at = now(), memory_count = $2
         WHERE persona_id = $3 AND name ILIKE $4`,
        [summary, rows.length, personaId, name]
      );
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_backfill_done", personaId, name, memoryCount: rows.length }));
    } catch (err) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_backfill_error", personaId, name, error: err.message }));
    }
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_backfill_complete", personaId, count: stale.length }));
}
