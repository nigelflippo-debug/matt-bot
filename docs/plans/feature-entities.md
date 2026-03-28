# Feature: Entity Profiles

## Summary

The `entities` table exists in the schema but is never read or written. Currently, entity profiles are assembled on-the-fly in `retrieveMemory()` by querying `memories WHERE person_name ILIKE $name` — a full scan every request.

This feature populates the `entities` table with a persistent, LLM-generated summary per person, kept in sync as memories are added. The read path then uses this summary instead of (or alongside) the raw memory rows.

## Current Behaviour

`retrieveMemory()` in `memory-store-pg.js`:
1. Detects if the query mentions a known person (from a DISTINCT scan of `person_name`)
2. Fetches all memory rows tagged with that person
3. Passes the raw rows to `generate.js` as `personProfile`
4. `generate.js` injects them as a block in the system prompt

Problems:
- Person detection is a case-insensitive DISTINCT scan on every request
- Profile is raw memory rows — verbose, unstructured, no synthesis
- `entities` table is wasted schema

## Proposed Behaviour

**Entity record** — one row per `(persona_id, name)` with:
- `name` — canonical first name (e.g. "Reed")
- `aliases` — JSONB array of alternate names/nicknames (already in schema)
- `summary` — LLM-generated paragraph: who this person is, key facts, relationship to the persona
- `summary_updated_at` — timestamp of last summary rebuild
- `memory_count` — denormalized count used to detect when a rebuild is needed

**Write path** — after any memory is written with a `person_name`:
- Upsert an `entities` row for that person (create if new, touch if existing)
- If memory count has grown by ≥ 3 since last summary rebuild, enqueue a background summary rebuild

**Read path** — in `retrieveMemory()`:
- Replace the DISTINCT person scan with a lookup against `entities` (indexed)
- If entity has a summary, inject the summary instead of raw rows
- Fall back to raw rows if no summary yet (new entity, hasn't been built yet)

**Summary rebuild** — worker job (or inline async):
- Fetch all memory rows for `(persona_id, person_name)`
- LLM prompt: "Summarise what {persona} knows about {person} in 2–3 sentences"
- UPDATE entities SET summary = ..., summary_updated_at = now(), memory_count = ...

## Scope

**In scope:**
- Add `summary TEXT`, `summary_updated_at TIMESTAMPTZ`, `memory_count INT DEFAULT 0` columns to `entities` (migration 004)
- `upsertEntity(personaId, personName)` helper in `memory-store-pg.js` — called after any memory write with a person_name
- `rebuildEntitySummary(personaId, personName)` in `memory-store-pg.js` — LLM rebuild, called async
- Update `addMemory()` to call `upsertEntity` + trigger rebuild if stale
- Update `retrieveMemory()` — use entities table for person detection; inject summary instead of raw rows when available
- Backfill job in `maintenance.js` — `rebuildStaleEntities()` — runs once (or weekly) to build summaries for existing person_name data

**Out of scope:**
- Alias resolution / name normalisation (Reed vs "Reed Wiley" vs "Big Reed") — future
- Cross-persona entity sharing
- Entity deletion / merging

## Acceptance Criteria

- [ ] `entities` table has `summary`, `summary_updated_at`, `memory_count` columns (migration 004)
- [ ] A new person mentioned in a `remember:` call gets an entity row created
- [ ] After 3+ new memories for a person, their summary is rebuilt in the background
- [ ] `retrieveMemory()` uses entities index for person detection (no DISTINCT scan)
- [ ] System prompt receives a synthesised summary paragraph instead of raw rows when available
- [ ] `rebuildStaleEntities()` in maintenance.js bootstraps summaries for existing data on first run

## Tasks

1. [ ] Migration 004: add `summary`, `summary_updated_at`, `memory_count` to `entities`
2. [ ] `upsertEntity(personaId, personName)` — INSERT ON CONFLICT DO UPDATE memory_count++
3. [ ] `rebuildEntitySummary(personaId, personName)` — fetch rows, LLM summarise, UPDATE entities
4. [ ] Wire `addMemory()` to call upsertEntity; trigger async rebuild if `memory_count % 3 === 0`
5. [ ] Update `retrieveMemory()` — entities lookup for detection; summary injection
6. [ ] `rebuildStaleEntities(personaId)` in maintenance.js — rebuild all entities with no summary
7. [ ] Run migration 004 in prod and trigger backfill

## Dependencies

- Features #1–4 complete (memories table, Postgres write path)

## Open Questions

- Should summary rebuild happen inline async (fire-and-forget in bot process) or go through the BullMQ worker? Worker is cleaner but adds a new job type. Inline async is simpler and the rebuild is a single LLM call.
- How many raw rows to cap the summary prompt at? (suggest: all rows, capped at 30 — summaries are generated from the full picture)
