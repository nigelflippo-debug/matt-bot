# Feature: Worker Reconciliation Pass

## Summary

This feature implements the full reconciliation logic in the worker: vector similarity pre-filter → coalesce LLM → contradiction check → promote staged entries to `memories`.

## Scope

**In scope:**
- `src/rag/reconcile.js` — reconciliation pass: fetch unreconciled staging rows, classify each by similarity, promote to `memories`
- Export `embedText` from `memory-store-pg.js` for use in reconcile
- Update `worker.js` — call `reconcile(persona_id)` after staging inserts (replaces the stub log)
- Add `OPENAI_API_KEY` to worker Railway env vars (required for LLM calls)

**Out of scope:**
- Redlock (Feature #7) — reconcile is designed to be wrapped with a lock; the lock is not added here
- Pruning / confidence decay (Features #10, #11)

## Acceptance Criteria

- [ ] Staging rows with similarity > 0.95 to an existing memory are marked reconciled and discarded (duplicate)
- [ ] Staging rows with similarity 0.7–0.95 go through coalesce LLM — merged, skipped, or promoted to add path
- [ ] Staging rows with similarity < 0.7 go through contradiction check — overwrite contradicted memory or insert new
- [ ] New memories written with confidence=0.8, source_weight=0.6, source='bot-inferred'
- [ ] Merged/overwritten memories write old version to `memory_versions` before update
- [ ] All processed staging rows have `reconciled_at` set
- [ ] Rows that error during processing are left unreconciled (retry on next pass)
- [ ] `worker.js` calls `reconcile(persona_id)` after each batch of staging inserts

## Approach

New file `src/rag/reconcile.js` exports `reconcile(personaId)`. Placed in `src/rag/` so it naturally imports OpenAI (via `memory-store.js`), the pool (via `db-client.js`), and the LLM helpers (`coalesce`, `checkContradiction` from `memory-store.js`).

**Similarity thresholds** (from architecture doc):
- `> 0.95` — duplicate, discard
- `0.7–0.95` — ambiguous, run coalesce LLM; if coalesce returns "add", fall through to contradiction check
- `< 0.7` — distinct, run contradiction check; add or replace

**Per-row processing:**
```
embed staging row text
→ pgvector top-10 against memories (with similarity score)
→ classify by maxSim:
    > 0.95 → mark reconciled, skip
    0.7–0.95 → coalesce(text, topCandidates)
        skip  → mark reconciled
        merge → UPDATE memory + write version + mark reconciled
        add   → fall through to contradiction check
    < 0.7 (or coalesce→add) → checkContradiction(text, allCandidates)
        contradicts → UPDATE memory + write version + mark reconciled
        clear       → INSERT new memory + mark reconciled
```

**New memories** use:
- `confidence = 0.8` (lower than explicit 1.0)
- `source_weight = 0.6` (bot-inferred, per plan)
- `source = 'bot-inferred'`
- `person_name` from staging row
- `expires_at` via `detectTemporalExpiry`

**Error handling:** each row is processed in a try/catch. On error: log and leave `reconciled_at` null so it's retried. The whole pass never throws — worker job always completes.

**Redlock readiness:** `reconcile(personaId)` is a single async function — wrapping with Redlock in Feature #7 requires no internal changes.

## Tasks

1. [x] Export `embedText` from `memory-store-pg.js`
2. [x] Create `src/rag/reconcile.js` — `reconcile(personaId)` with full per-row logic
3. [x] Update `worker.js` — import and call `reconcile(persona_id)` after staging inserts
4. [ ] Add `OPENAI_API_KEY` to memory-worker Railway service env vars

## Edge Cases & Error Handling

- No unreconciled rows: `reconcile` returns immediately (SELECT returns empty)
- All candidates below 0.7 but array non-empty: contradiction check still runs against them — avoids inserting contradictory facts even when similarity is low
- `embedText` fails: throw from row processing, caught per-row, row stays unreconciled
- Coalesce LLM returns malformed JSON: defaults to `{action: 'add'}` (existing behavior in `coalesce()`)
- Contradiction check fails: defaults to no contradiction (existing behavior)

## Dependencies

- Feature #1 — `memories`, `memory_staging`, `memory_versions` tables
- Feature #4 — `coalesce`, `checkContradiction`, `detectTemporalExpiry` exported from `memory-store.js`; `embedText` in `memory-store-pg.js`
- Feature #5 — staging rows being populated by worker
- `OPENAI_API_KEY` env var on memory-worker service

## Open Questions

_(none)_
