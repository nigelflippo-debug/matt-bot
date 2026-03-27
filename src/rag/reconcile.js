/**
 * reconcile.js — worker reconciliation pass
 *
 * Fetches unreconciled memory_staging rows for a persona, classifies each by
 * vector similarity against existing memories, and promotes to memories.
 *
 * Similarity thresholds:
 *   > 0.95  — duplicate, discard
 *   0.7–0.95 — ambiguous, coalesce LLM → merge | skip | (fall through to add path)
 *   < 0.7   — distinct, contradiction check → add or replace
 *
 * Called by the worker after each staging insert batch.
 * Designed to be wrapped with Redlock in Feature #7 — no internal changes needed.
 */

import OpenAI from "openai";
import { getPool } from "./db-client.js";

const openai = new OpenAI();

// ---------------------------------------------------------------------------
// Embedding helpers (inlined — no persona-loader dependency)
// ---------------------------------------------------------------------------

function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

async function embedText(text) {
  const res = await openai.embeddings.create({ model: "text-embedding-3-small", input: [text] });
  return toVectorLiteral(res.data[0].embedding);
}

// ---------------------------------------------------------------------------
// LLM helpers (inlined from memory-store.js — no persona-loader dependency)
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
      { role: "user", content: `EXISTING FACTS:\n${existingList}\n\nNEW FACT:\n${newFact}` },
    ],
  });
  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { action: "add" };
  }
}

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

function detectTemporalExpiry(text, now = new Date()) {
  const t = text.toLowerCase();
  if (/\b(for now|temporarily|just for now|for the time being)\b/.test(t)) {
    return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (/\b(today|tonight|this morning|this afternoon|this evening)\b/.test(t)) {
    const end = new Date(now); end.setHours(23, 59, 59, 999); return end.toISOString();
  }
  if (/\btomorrow\b/.test(t)) {
    const end = new Date(now); end.setDate(end.getDate() + 1); end.setHours(23, 59, 59, 999); return end.toISOString();
  }
  if (/\bthis weekend\b/.test(t)) {
    const end = new Date(now); end.setDate(end.getDate() + ((7 - end.getDay()) % 7 || 7)); end.setHours(23, 59, 59, 999); return end.toISOString();
  }
  if (/\bthis week\b/.test(t)) {
    const end = new Date(now); end.setDate(end.getDate() + ((7 - end.getDay()) % 7 || 7)); end.setHours(23, 59, 59, 999); return end.toISOString();
  }
  if (/\bnext week\b/.test(t)) {
    const end = new Date(now); end.setDate(end.getDate() + ((7 - end.getDay()) % 7 || 7) + 7); end.setHours(23, 59, 59, 999); return end.toISOString();
  }
  if (/\bthis month\b/.test(t)) {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
  }
  if (/\bnext month\b/.test(t)) {
    return new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999).toISOString();
  }
  if (/\bnext year\b/.test(t)) {
    return new Date(now.getFullYear() + 1, 11, 31, 23, 59, 59, 999).toISOString();
  }
  const inDays = t.match(/\bin (\d+) days?\b/);
  if (inDays) {
    const end = new Date(now); end.setDate(end.getDate() + parseInt(inDays[1])); end.setHours(23, 59, 59, 999); return end.toISOString();
  }
  return null;
}

const SIM_DUPLICATE  = 0.95;
const SIM_AMBIGUOUS  = 0.70;
const CANDIDATE_LIMIT = 10;

const BOT_INFERRED_CONFIDENCE    = 0.8;
const BOT_INFERRED_SOURCE_WEIGHT = 0.6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeVersion(pool, memoryId, text, confidence, reason) {
  try {
    await pool.query(
      `INSERT INTO memory_versions (memory_id, text, confidence, reason) VALUES ($1, $2, $3, $4)`,
      [memoryId, text, confidence, reason]
    );
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_version_error", memoryId, error: err.message }));
  }
}

async function markReconciled(pool, stagingId) {
  await pool.query(
    `UPDATE memory_staging SET reconciled_at = now() WHERE id = $1`,
    [stagingId]
  );
}

async function getSimilarMemories(pool, personaId, vector) {
  const { rows } = await pool.query(
    `SELECT id, text, person_name, confidence, source_weight,
            1 - (embedding <=> $1::vector) AS similarity
     FROM memories
     WHERE persona_id = $2
       AND category = 'memory'
       AND embedding IS NOT NULL
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vector, personaId, CANDIDATE_LIMIT]
  );
  return rows.map((r) => ({ ...r, similarity: parseFloat(r.similarity) }));
}

// ---------------------------------------------------------------------------
// Per-row reconciliation
// ---------------------------------------------------------------------------

/** Returns "promoted" | "merged" | "duplicate" | "skipped" */
async function reconcileRow(pool, personaId, row) {
  const { id: stagingId, text, person_name } = row;

  let vector;
  try {
    vector = await embedText(text);
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_embed_error", stagingId, error: err.message }));
    throw err; // leave unreconciled, retry next pass
  }

  const candidates = await getSimilarMemories(pool, personaId, vector);
  const maxSim = candidates.length > 0 ? candidates[0].similarity : 0;

  // --- Duplicate: similarity > 0.95 ---
  if (maxSim > SIM_DUPLICATE) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_duplicate", stagingId, maxSim, text: text.slice(0, 60) }));
    await markReconciled(pool, stagingId);
    return "duplicate";
  }

  // --- Ambiguous: 0.7–0.95 → coalesce ---
  if (maxSim >= SIM_AMBIGUOUS) {
    const topCandidates = candidates.filter((c) => c.similarity >= SIM_AMBIGUOUS);
    const result = await coalesce(text, topCandidates);
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_coalesce", stagingId, action: result.action, maxSim, text: text.slice(0, 60) }));

    if (result.action === "skip") {
      await markReconciled(pool, stagingId);
      return "skipped";
    }

    if (result.action === "merge" && typeof result.index === "number" && topCandidates[result.index]) {
      const target = topCandidates[result.index];
      const mergedVector = await embedText(result.merged);
      await writeVersion(pool, target.id, target.text, target.confidence, "reconcile_merge");
      await pool.query(
        `UPDATE memories SET text = $1, embedding = $2::vector, updated_at = now() WHERE id = $3`,
        [result.merged, mergedVector, target.id]
      );
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_merged", stagingId, memoryId: target.id, text: result.merged.slice(0, 80) }));
      await markReconciled(pool, stagingId);
      return "merged";
    }
    // coalesce returned "add" — fall through to contradiction check
  }

  // --- Distinct or coalesce→add: contradiction check ---
  const contradiction = await checkContradiction(text, candidates);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_contradiction_check", stagingId, contradicts: contradiction.contradicts, candidateCount: candidates.length }));

  if (contradiction.contradicts && typeof contradiction.index === "number" && candidates[contradiction.index]) {
    const target = candidates[contradiction.index];
    // Source weight guard: bot-inferred should not overwrite higher-confidence explicit memories
    if (BOT_INFERRED_SOURCE_WEIGHT < target.source_weight) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_weight_guard", stagingId, memoryId: target.id, newWeight: BOT_INFERRED_SOURCE_WEIGHT, existingWeight: target.source_weight }));
      await markReconciled(pool, stagingId);
      return "skipped";
    }
    await writeVersion(pool, target.id, target.text, target.confidence, "reconcile_contradiction");
    await pool.query(
      `UPDATE memories SET text = $1, embedding = $2::vector, person_name = $3, updated_at = now() WHERE id = $4`,
      [text, vector, person_name, target.id]
    );
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_overwrite", stagingId, memoryId: target.id, old: target.text.slice(0, 80), new: text.slice(0, 80) }));
    await markReconciled(pool, stagingId);
    return "merged";
  }

  // --- New memory ---
  const expiresAt = detectTemporalExpiry(text);
  await pool.query(
    `INSERT INTO memories
       (persona_id, category, text, embedding, person_name, confidence, source, source_weight, expires_at, added_at)
     VALUES ($1, 'memory', $2, $3::vector, $4, $5, 'bot-inferred', $6, $7, now())`,
    [personaId, text, vector, person_name, BOT_INFERRED_CONFIDENCE, BOT_INFERRED_SOURCE_WEIGHT, expiresAt ?? null]
  );
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_inserted", stagingId, person: person_name, expiresAt, text: text.slice(0, 80) }));
  await markReconciled(pool, stagingId);
  return "promoted";
}

// ---------------------------------------------------------------------------
// Public: reconcile
// ---------------------------------------------------------------------------

/**
 * Run the reconciliation pass for a given persona.
 * Fetches all unreconciled staging rows and processes each one.
 * Never throws — errors per row are caught and logged.
 */
export async function reconcile(personaId) {
  const pool = getPool();

  const { rows: pending } = await pool.query(
    `SELECT id, text, person_name, source, added_at
     FROM memory_staging
     WHERE persona_id = $1 AND reconciled_at IS NULL
     ORDER BY added_at`,
    [personaId]
  );

  if (pending.length === 0) return;

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_start", personaId, count: pending.length }));

  const counts = { promoted: 0, merged: 0, duplicate: 0, skipped: 0, errors: 0 };

  for (const row of pending) {
    try {
      const outcome = await reconcileRow(pool, personaId, row);
      counts[outcome]++;
    } catch (err) {
      counts.errors++;
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_row_error", stagingId: row.id, error: err.message }));
    }
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "reconcile_done", personaId, total: pending.length, ...counts }));
}
