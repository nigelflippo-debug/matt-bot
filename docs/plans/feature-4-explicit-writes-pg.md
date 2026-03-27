# Feature: Explicit Write Path — Postgres

## Summary

This feature migrates explicit memory writes (`remember:`, `directive:`, `forget:`, `read:`) to write synchronously to Postgres with inline embedding, so users get accurate feedback and all bot instances immediately see the change.

## Scope

**In scope:**
- Export LLM helpers from `memory-store.js` so they can be reused without duplication
- `src/rag/migrations/003_add_source_url.sql` — adds `source_url TEXT` to memories
- Add `addMemory` and `removeMemory` to `memory-store-pg.js` (Postgres-backed)
  - Inline embedding at write time (no deferred `embedPendingMemory` step)
  - Coalesce + contradiction check against Postgres candidates (pgvector pre-filter)
  - `memory_versions` audit record on merge/overwrite
  - `detectTemporalExpiry`, directive cap, `source_weight` applied at write time
- Fix `await` bug on `getAllMemory()` call in bot.js (introduced in Feature #3)
- Update `bot.js` imports: `addMemory`, `removeMemory` from `memory-store-pg.js`

**Out of scope:**
- Inferred write path (`extractImplicit` → queue) — Feature #5
- `addImplicit` — Feature #5
- Removing old file-based write code — Feature #8

## Acceptance Criteria

- [ ] `remember: X` writes to Postgres; user gets added/merged/skipped/split feedback
- [ ] `remember for now: X` writes with correct `expires_at`; 📅 reaction fires
- [ ] `directive: X` writes category=directive; capped at 20; 🫡 reaction fires
- [ ] `forget: X` removes matching rows from Postgres; returns removed count and text
- [ ] `read: <url>` imported facts stored in Postgres with `source='url-import'` and `source_url`
- [ ] Merges write old version to `memory_versions` before updating
- [ ] `list memory` works (await fix applied)
- [ ] Return shapes identical to current — no bot.js logic changes beyond import swap

## Approach

**Reuse LLM helpers** — `splitOrClassify`, `coalesce`, `checkContradiction`, `detectTemporalExpiry` are exported from `memory-store.js` and imported into `memory-store-pg.js`. No duplication.

**Embedding at write time** — each `addMemory` call embeds the text inline before inserting. No separate `embedPendingMemory` step. Entries are immediately searchable via pgvector.

**Candidate pre-filter** — replaces the Vectra-based `preFilterCandidates`. For memories: pgvector similarity query `ORDER BY embedding <=> $vector LIMIT 20`. For directives: SELECT all (max 20 by cap).

**Write flow per part:**
```
splitOrClassify(text)
  → directive: cap check → coalesce against all directives → skip/merge/insert
  → memory:   embed → pgvector top-20 candidates → coalesce → skip | merge+version | add
                       if add: contradiction check → overwrite+version | insert new
```

**`memory_versions`** — written before any UPDATE (merge or contradiction overwrite). Stores old text + confidence + reason.

**`source_weight`** — explicit writes use `1.0`; url-import uses `0.8` (lower than explicit, user-directed but indirect). Added to migration.

## Tasks

1. [x] Export `splitOrClassify`, `coalesce`, `checkContradiction`, `detectTemporalExpiry` from `memory-store.js`
2. [x] Create `src/rag/migrations/003_add_source_url.sql` — `ADD COLUMN IF NOT EXISTS source_url TEXT`
3. [x] Add `addMemory(text, addedBy, opts)` to `memory-store-pg.js`
4. [x] Add `removeMemory(query)` to `memory-store-pg.js`
5. [x] Update `bot.js`: import `addMemory`, `removeMemory` from `memory-store-pg.js`; fix `await getAllMemory()`

## Edge Cases & Error Handling

- Directive cap hit: return `{action: 'capped', category}` — same as current
- Coalesce LLM failure: default to `{action: 'add'}` — same as current
- Contradiction check failure: default to no contradiction — same as current
- Embedding fails: throw — user command fails cleanly, no partial write
- `memory_versions` insert fails: log and continue — audit loss is acceptable vs. blocking the write

## Dependencies

- Feature #1 — `memories`, `memory_versions` tables
- Feature #3 — `memory-store-pg.js` exists, read functions in place
- Migration `003` must be run before deployment

## Open Questions

_(none)_
