/**
 * memory-store-pg.js — Postgres-backed memory reads and explicit writes
 *
 * Replaces file/vectra read+write path in memory-store.js.
 * Inferred writes (addImplicit, extractImplicit) remain in memory-store.js until Feature #5.
 *
 * Exports:
 *   retrieveMemory(query, k) → { memories, personProfile }
 *   getDirectives()          → entry[]
 *   getAllMemory()            → entry[]
 *   addMemory(text, addedBy, opts) → { action, category?, temporal? }
 *   removeMemory(query)      → { removed, entries }
 */

import "dotenv/config";
import OpenAI from "openai";
import { getPool } from "./db-client.js";
import { getPersona } from "../persona/loader.js";
import { splitOrClassify, coalesce, checkContradiction, detectTemporalExpiry } from "./memory-store.js";

const openai = new OpenAI();
const personaId = getPersona().id;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Access recency score: 1.0 if accessed within 7 days, 0.0 at 30+ days.
 */
function computeAccessRecency(lastAccessedAt) {
  if (!lastAccessedAt) return 0;
  const daysSince = (Date.now() - new Date(lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - daysSince / 30);
}

/**
 * Serialize a float[] embedding to the Postgres vector literal format.
 */
function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Public: retrieveMemory
// ---------------------------------------------------------------------------

/**
 * Retrieve the top K most relevant memory entries for a given query.
 *
 * - pgvector similarity search (cosine) filtered to non-expired memories
 * - Salience re-ranking: semantic score * 0.7 + access recency * 0.3
 * - Person boost: memories tagged with a name mentioned in the query sorted first
 * - Entity profile: all memories for that person returned separately
 * - Staging fallback: recent unreconciled memory_staging rows injected
 * - last_accessed_at updated for all returned rows
 *
 * Returns { memories: row[], personProfile: { person, memories: row[] } | null }
 */
export async function retrieveMemory(query, k = 5) {
  const pool = getPool();

  // Embed the query
  const embResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: [query],
  });
  const vector = toVectorLiteral(embResponse.data[0].embedding);

  // Vector similarity search — fetch 3x to allow salience re-ranking
  const { rows: semanticRows } = await pool.query(
    `SELECT id, text, person_name, confidence, source, last_accessed_at, added_at,
            1 - (embedding <=> $1::vector) AS similarity
     FROM memories
     WHERE persona_id = $2
       AND category = 'memory'
       AND embedding IS NOT NULL
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vector, personaId, k * 3]
  );

  // Salience re-ranking: semantic * 0.7 + access recency * 0.3
  const queryLower = query.toLowerCase();
  const scored = semanticRows
    .map((row) => ({
      row,
      salience: parseFloat(row.similarity) * 0.7 + computeAccessRecency(row.last_accessed_at) * 0.3,
    }))
    .sort((a, b) => b.salience - a.salience)
    .map(({ row }) => row);

  // Person boost: entries tagged with a name mentioned in the query float to top
  const personMatches = scored.filter((r) => r.person_name && queryLower.includes(r.person_name.toLowerCase()));
  const others = scored.filter((r) => !r.person_name || !queryLower.includes(r.person_name.toLowerCase()));
  const memories = [...personMatches, ...others].slice(0, k);

  // Entity profile: use entities table for indexed person detection + summary injection
  let personProfile = null;
  const { rows: knownEntities } = await pool.query(
    `SELECT name, summary FROM entities
     WHERE persona_id = $1
     ORDER BY memory_count DESC`,
    [personaId]
  );
  const matchedEntity = knownEntities.find((e) => queryLower.includes(e.name.toLowerCase()));

  if (matchedEntity) {
    if (matchedEntity.summary) {
      // Use synthesised summary — cleaner injection, no raw rows needed
      personProfile = { person: matchedEntity.name, summary: matchedEntity.summary, memories: [] };
    } else {
      // No summary yet — fall back to raw rows
      const { rows: profileRows } = await pool.query(
        `SELECT id, text, person_name, confidence, source, last_accessed_at, added_at
         FROM memories
         WHERE persona_id = $1
           AND category = 'memory'
           AND person_name ILIKE $2
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY last_accessed_at DESC NULLS LAST
         LIMIT 15`,
        [personaId, matchedEntity.name]
      );
      if (profileRows.length > 0) {
        personProfile = { person: matchedEntity.name, summary: null, memories: profileRows };
      }
    }
  }

  // Staging fallback: inject recent unreconciled entries not yet in memories
  let stagingInjected = 0;
  try {
    const { rows: stagingRows } = await pool.query(
      `SELECT text, person_name FROM memory_staging
       WHERE persona_id = $1
         AND reconciled_at IS NULL
         AND added_at > now() - interval '10 minutes'
       ORDER BY added_at DESC`,
      [personaId]
    );

    for (const staged of stagingRows) {
      const alreadyPresent = memories.some((m) => m.text === staged.text);
      if (!alreadyPresent) {
        memories.push({
          id: "staging",
          text: staged.text,
          person_name: staged.person_name,
          category: "memory",
          last_accessed_at: null,
        });
        stagingInjected++;
      }
    }
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "staging_fallback_error", error: err.message }));
  }

  // Update last_accessed_at for all returned memory rows (skip staging placeholders)
  const returnedIds = [
    ...memories.map((r) => r.id),
    ...(personProfile?.memories ?? []).map((r) => r.id),
  ].filter((id) => id !== "staging");

  if (returnedIds.length > 0) {
    try {
      await pool.query(
        `UPDATE memories SET last_accessed_at = now() WHERE id = ANY($1::uuid[])`,
        [returnedIds]
      );
    } catch (err) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "last_accessed_update_error", error: err.message }));
    }
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    stage: "memory_retrieve_pg",
    count: memories.length,
    personProfile: personProfile?.person ?? null,
    personProfileCount: personProfile?.memories.length ?? 0,
    personBoosted: personMatches.length,
    stagingInjected,
    memories: memories.slice(0, k).map((r) => ({ text: r.text.slice(0, 60), person: r.person_name })),
  }));

  return { memories: memories.slice(0, k), personProfile };
}

// ---------------------------------------------------------------------------
// Public: getDirectives
// ---------------------------------------------------------------------------

/**
 * Return all directive entries for this persona.
 * Always injected into the system prompt — no vector search needed.
 */
export async function getDirectives() {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, text, added_at FROM memories
     WHERE persona_id = $1 AND category = 'directive'
     ORDER BY added_at`,
    [personaId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Public: getAllMemory
// ---------------------------------------------------------------------------

/**
 * Return all memory entries for this persona (for the `list memory` command).
 */
export async function getAllMemory() {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, text, person_name, category, confidence, source, expires_at, last_accessed_at, added_at, updated_at
     FROM memories
     WHERE persona_id = $1
     ORDER BY added_at DESC`,
    [personaId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

const DIRECTIVE_CAP = 20;

/**
 * Embed a text string and return the Postgres vector literal.
 */
export async function embedText(text) {
  const res = await openai.embeddings.create({ model: "text-embedding-3-small", input: [text] });
  return toVectorLiteral(res.data[0].embedding);
}

/**
 * Write the current state of a memory row to memory_versions before mutating it.
 */
async function writeVersion(pool, memoryId, text, confidence, reason) {
  try {
    await pool.query(
      `INSERT INTO memory_versions (memory_id, text, confidence, reason) VALUES ($1, $2, $3, $4)`,
      [memoryId, text, confidence, reason]
    );
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_version_error", memoryId, error: err.message }));
  }
}

/**
 * Get pgvector top-N candidates for coalesce pre-filtering.
 */
async function getCandidates(pool, vector, category, n = 20) {
  const { rows } = await pool.query(
    `SELECT id, text, person_name, confidence
     FROM memories
     WHERE persona_id = $1
       AND category = $2
       AND embedding IS NOT NULL
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY embedding <=> $3::vector
     LIMIT $4`,
    [personaId, category, vector, n]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Public: addMemory
// ---------------------------------------------------------------------------

/**
 * Add a new memory or directive entry, with inline coalesce + contradiction check.
 * Writes embedding to Postgres synchronously — no deferred embedPendingMemory step.
 *
 * Returns { action: 'added'|'merged'|'skipped'|'capped'|'split', category?, temporal? }
 */
export async function addMemory(text, addedBy = "unknown", opts = {}) {
  const parts = await splitOrClassify(text);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_classified_pg", parts: parts.map((p) => ({ category: p.category, person: p.person, text: p.text.slice(0, 60) })) }));

  if (parts.length > 1) {
    await Promise.all(parts.map((p) => addSingle(p.text, p.category, addedBy, p.person, opts)));
    return { action: "split" };
  }

  return addSingle(parts[0].text, parts[0].category, addedBy, parts[0].person, opts);
}

async function addSingle(text, category, addedBy, person = null, opts = {}) {
  const pool = getPool();

  if (category === "directive") {
    // Cap check
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM memories WHERE persona_id = $1 AND category = 'directive'`,
      [personaId]
    );
    if (parseInt(countRows[0].cnt, 10) >= DIRECTIVE_CAP) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_capped_pg", category }));
      return { action: "capped", category };
    }

    // Coalesce against all existing directives
    const { rows: existing } = await pool.query(
      `SELECT id, text, confidence FROM memories WHERE persona_id = $1 AND category = 'directive' ORDER BY added_at`,
      [personaId]
    );
    const result = await coalesce(text, existing);
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_coalesce_pg", category, text: text.slice(0, 60), result }));

    if (result.action === "skip") return { action: "skipped", category };

    if (result.action === "merge" && typeof result.index === "number" && existing[result.index]) {
      const target = existing[result.index];
      await writeVersion(pool, target.id, target.text, target.confidence, "merge");
      await pool.query(
        `UPDATE memories SET text = $1, updated_at = now() WHERE id = $2`,
        [result.merged, target.id]
      );
      console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_merged_pg", category, id: target.id, text: result.merged.slice(0, 80) }));
      return { action: "merged", category };
    }

    // Insert new directive (no embedding for directives)
    await pool.query(
      `INSERT INTO memories (persona_id, category, text, person_name, confidence, source, source_weight, added_at)
       VALUES ($1, 'directive', $2, NULL, 1.0, 'explicit', 1.0, now())`,
      [personaId, text]
    );
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_added_pg", category, text: text.slice(0, 80) }));
    return { action: "added", category };
  }

  // --- memory category ---
  const vector = await embedText(text);

  // Coalesce against pgvector top-20 candidates
  const candidates = await getCandidates(pool, vector, "memory");
  const result = await coalesce(text, candidates);
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_coalesce_pg", category, person, text: text.slice(0, 60), candidateCount: candidates.length, result }));

  if (result.action === "skip") return { action: "skipped", category };

  if (result.action === "merge" && typeof result.index === "number" && candidates[result.index]) {
    const target = candidates[result.index];
    const mergedVector = await embedText(result.merged);
    await writeVersion(pool, target.id, target.text, target.confidence, "merge");
    await pool.query(
      `UPDATE memories SET text = $1, embedding = $2::vector, updated_at = now() WHERE id = $3`,
      [result.merged, mergedVector, target.id]
    );
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_merged_pg", category, person, id: target.id, text: result.merged.slice(0, 80) }));
    return { action: "merged", category };
  }

  // Contradiction check before inserting
  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_contradiction_check_pg", category, person, candidateCount: candidates.length, text: text.slice(0, 60) }));
  const contradiction = await checkContradiction(text, candidates);

  if (contradiction.contradicts && typeof contradiction.index === "number" && candidates[contradiction.index]) {
    const target = candidates[contradiction.index];
    await writeVersion(pool, target.id, target.text, target.confidence, "contradiction");
    await pool.query(
      `UPDATE memories SET text = $1, embedding = $2::vector, person_name = $3, updated_at = now() WHERE id = $4`,
      [text, vector, person, target.id]
    );
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_contradiction_pg", category, person, id: target.id, old: target.text.slice(0, 80), new: text.slice(0, 80) }));
    return { action: "merged", category, contradiction: true };
  }

  // Insert new memory
  const now = new Date();
  const expiresAt = detectTemporalExpiry(text, now);
  const source = opts.source ?? "explicit";
  const sourceWeight = source === "url-import" ? 0.8 : 1.0;

  await pool.query(
    `INSERT INTO memories (persona_id, category, text, embedding, person_name, confidence, source, source_weight, source_url, expires_at, added_at)
     VALUES ($1, 'memory', $2, $3::vector, $4, 1.0, $5, $6, $7, $8, now())`,
    [personaId, text, vector, person, source, sourceWeight, opts.sourceUrl ?? null, expiresAt ?? null]
  );
  console.log(JSON.stringify({ ts: now.toISOString(), stage: "memory_added_pg", category, person, expiresAt, source, text: text.slice(0, 80) }));
  if (expiresAt) console.log(JSON.stringify({ ts: now.toISOString(), stage: "memory_temporal_pg", category, person, expiresAt, text: text.slice(0, 80) }));

  // Upsert entity and trigger incremental summary rebuild every 3 new memories
  if (person) {
    upsertEntity(pool, personaId, person).then((count) => {
      if (count % 3 === 0) {
        rebuildEntitySummary(personaId, person).catch(() => {});
      }
    }).catch(() => {});
  }

  return { action: "added", category, temporal: !!expiresAt };
}

// ---------------------------------------------------------------------------
// Entity helpers
// ---------------------------------------------------------------------------

/**
 * Upsert an entity row for a named person.
 * Creates if new; increments memory_count if existing.
 * Returns the updated memory_count so the caller can decide whether to rebuild.
 */
async function upsertEntity(pool, personaId, personName) {
  const { rows } = await pool.query(
    `INSERT INTO entities (persona_id, name)
     VALUES ($1, $2)
     ON CONFLICT (persona_id, name) DO UPDATE
       SET memory_count = entities.memory_count + 1
     RETURNING memory_count`,
    [personaId, personName]
  );
  return rows[0]?.memory_count ?? 1;
}

/**
 * Rebuild the LLM summary for a named entity.
 * Fetches up to 30 memories tagged with that person and summarises them.
 */
export async function rebuildEntitySummary(personaId, personName) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT text FROM memories
     WHERE persona_id = $1
       AND person_name ILIKE $2
       AND category = 'memory'
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY confidence DESC, last_accessed_at DESC NULLS LAST
     LIMIT 30`,
    [personaId, personName]
  );
  if (rows.length === 0) return;

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
        {
          role: "user",
          content: `Person: ${personName}\n\nKnown facts:\n${factList}`,
        },
      ],
    });
    const summary = response.choices[0].message.content.trim();
    await pool.query(
      `UPDATE entities
       SET summary = $1, summary_updated_at = now(), memory_count = $2
       WHERE persona_id = $3 AND name ILIKE $4`,
      [summary, rows.length, personaId, personName]
    );
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_summary_rebuilt", personaId, personName, memoryCount: rows.length }));
  } catch (err) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "entity_summary_error", personaId, personName, error: err.message }));
  }
}

// ---------------------------------------------------------------------------
// Public: removeMemory
// ---------------------------------------------------------------------------

/**
 * Remove memory entries semantically matching the query.
 * Memory: pgvector similarity search. Directives: LLM match.
 * Returns { removed: number, entries: [{id, text, category}] }
 */
export async function removeMemory(query) {
  const pool = getPool();
  const embResponse = await openai.embeddings.create({ model: "text-embedding-3-small", input: [query] });
  const vector = toVectorLiteral(embResponse.data[0].embedding);

  // Semantic search for memory entries
  const { rows: semanticRows } = await pool.query(
    `SELECT id, text, category, 1 - (embedding <=> $1::vector) AS similarity
     FROM memories
     WHERE persona_id = $2
       AND category = 'memory'
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 5`,
    [vector, personaId]
  );
  const semanticMatches = semanticRows.filter((r) => parseFloat(r.similarity) > 0.3);

  // LLM match for directives
  const { rows: directives } = await pool.query(
    `SELECT id, text, category FROM memories WHERE persona_id = $1 AND category = 'directive' ORDER BY added_at`,
    [personaId]
  );
  const directiveMatches = [];
  if (directives.length > 0) {
    const list = directives.map((e, i) => `${i}: ${e.text}`).join("\n");
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `Given a list of directives and a user query, return the indices of any directives the user is trying to remove. Only include directives that clearly match the intent. Return {"indices": []} if nothing matches.\nRespond with JSON only.` },
          { role: "user", content: `DIRECTIVES:\n${list}\n\nQUERY: ${query}` },
        ],
      });
      const result = JSON.parse(response.choices[0].message.content);
      for (const i of result.indices ?? []) {
        if (directives[i]) directiveMatches.push(directives[i]);
      }
    } catch { /* ignore parse errors */ }
  }

  // Deduplicate
  const seen = new Set();
  const toRemove = [...semanticMatches, ...directiveMatches].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  if (toRemove.length === 0) return { removed: 0, entries: [] };

  const ids = toRemove.map((e) => e.id);
  await pool.query(`DELETE FROM memories WHERE id = ANY($1::uuid[])`, [ids]);

  // Clean up entity rows that no longer have any associated memories
  await pool.query(
    `DELETE FROM entities
     WHERE persona_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM memories m
         WHERE m.persona_id = entities.persona_id
           AND m.person_name = entities.name
           AND m.category = 'memory'
       )`,
    [personaId]
  );

  console.log(JSON.stringify({ ts: new Date().toISOString(), stage: "memory_removed_pg", count: toRemove.length, ids }));
  return { removed: toRemove.length, entries: toRemove.map((e) => ({ id: e.id, text: e.text, category: e.category })) };
}
