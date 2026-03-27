# Feature: Memory Reads — Postgres

## Summary

This feature migrates bot memory reads to query Postgres directly so that all bot instances share a single consistent view of memory.

## Scope

**In scope:**
- `src/rag/migrations/002_add_person_name.sql` — adds `person_name TEXT` to `memories`
- `src/rag/memory-store-pg.js` — Postgres-backed `retrieveMemory`, `getDirectives`, `getAllMemory`
  - pgvector similarity search with salience scoring (semantic 70% + access recency 30%)
  - Person boost + entity profile via `person_name` column
  - `memory_staging` fallback for recent unreconciled entries
  - `last_accessed_at` update on returned memories
- `bot.js` — swap 3 read-function imports to `memory-store-pg.js`

**Out of scope:**
- Write paths (`addMemory`, `addImplicit`, etc.) — Features #4, #5
- `embedPendingMemory` — no longer needed at read time (embeddings stored at write time in #4); left in place until #8 removes old code
- `pruneExpired`, `pruneStale`, `attributePersons`, `deduplicateMemory` — write-side maintenance, stay in `memory-store.js` for now
- Removing file-based code — Feature #8
- Data migration — Feature #13
- Production deployment — held until full cutover (#3–#8 + #13 together)

## Acceptance Criteria

- [ ] `retrieveMemory(query, k)` returns `{ memories, personProfile }` with the same shape as current — results ranked by salience
- [ ] Person mentioned in query surfaces their memories to the top; entity profile populated from `person_name` column
- [ ] Recent unreconciled `memory_staging` rows injected as fallback (bridges extraction → reconciliation gap)
- [ ] `last_accessed_at` updated in Postgres for all returned memory rows
- [ ] `getDirectives()` returns all directive rows for the persona
- [ ] `getAllMemory()` returns all memory rows for the persona (for `list memory` command)
- [ ] Bot behavior unchanged — same return shapes, no bot.js logic changes beyond import swap

## Approach

New file `memory-store-pg.js` exports the three read functions backed by Postgres. The bot imports these instead of the equivalents from `memory-store.js`. Write functions (`addMemory`, `removeMemory`, etc.) continue to come from `memory-store.js` until Feature #4.

`person_name` added to `memories` via a second migration (`002`). Mirrors the current JSON `person` field. Entity profile queries use `WHERE person_name ILIKE $name` — no JOIN to `entities` required at this stage.

Salience scoring done in JS after fetch, identical formula to current: `similarity * 0.7 + accessRecency * 0.3`, where `accessRecency` scales from 1.0 (within 7 days) to 0.0 (30+ days).

Similarity score retrieved via `1 - (embedding <=> $vector::vector) AS similarity` in the SELECT — actual cosine similarity, not a proxy.

Staging fallback: SELECT unreconciled rows from `memory_staging` added in the last 10 minutes for this persona. Person-matched rows injected into `memories`; others injected if not already covered. Replaces the in-memory `recentExtractions` cache.

## Tasks

1. [x] Create `src/rag/migrations/002_add_person_name.sql` — `ALTER TABLE memories ADD COLUMN IF NOT EXISTS person_name TEXT`
2. [x] Create `src/rag/memory-store-pg.js`:
   - `retrieveMemory(query, k=5)` — embed → pgvector search → salience sort → person boost → entity profile → staging fallback → update lastAccessedAt
   - `getDirectives()` — SELECT category=directive for persona
   - `getAllMemory()` — SELECT all for persona
3. [x] Update `src/discord-bot/bot.js` — import `retrieveMemory`, `getDirectives`, `getAllMemory` from `memory-store-pg.js`; keep all other imports from `memory-store.js`

## Edge Cases & Error Handling

- No embedding on a memory row (written before #4): excluded from similarity search via `WHERE embedding IS NOT NULL`; won't appear in results until re-embedded by #4
- DB unavailable: throws — deployment is coordinated, no file fallback needed
- Empty results (empty DB pre-migration): returns empty arrays — bot generates without memory context, acceptable during dev/test
- Person name detected but no matching rows: `personProfile = null`, no error
- `memory_staging` query fails: log and skip — staging fallback is best-effort, not critical

## Dependencies

- Feature #1 — `memories`, `memory_staging` tables
- `pg` in `src/rag/package.json` (done)
- `DATABASE_URL` env var on bot services
- Migration `002` must be run before deployment

## Open Questions

_(none)_
