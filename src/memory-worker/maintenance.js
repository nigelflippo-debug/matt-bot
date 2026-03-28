/**
 * maintenance.js — scheduled maintenance passes for the memory-worker
 *
 * runDecay()   — weekly: decay confidence on stale bot-inferred memories
 * runPruning() — daily:  delete expired and never-accessed stale memories
 */

import { getPool } from "../rag/db-client.js";

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
