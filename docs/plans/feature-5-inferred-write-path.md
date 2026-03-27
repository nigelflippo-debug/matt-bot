# Feature: Inferred Write Path — Queue

## Summary

This feature replaces the synchronous `addImplicit()` call with an async publish to the Redis queue so that bot-inferred memory extraction never blocks response generation.

## Scope

**In scope:**
- Update `runImplicitExtraction()` in bot.js: publish facts to queue instead of calling `addImplicit` per fact
- Import `publishInferredMemory` from `queue-client.js`
- Import `detectTemporalExpiry` from `memory-store.js` for 📅 reaction (temporal check stays in bot)
- Remove `addImplicit` from bot.js imports (no longer called)
- 🧠 reaction fires when facts are queued; 📅 fires if any fact contains a temporal reference

**Out of scope:**
- Worker reconciliation logic (Feature #6)
- Removing `addImplicit` from `memory-store.js` — Feature #8
- `extractImplicit()` — unchanged, stays in `memory-store.js`

## Acceptance Criteria

- [ ] Bot extracts facts and publishes one queue job per conversation (not per fact)
- [ ] Worker receives job and inserts rows into `memory_staging` (already handled by Feature #2)
- [ ] 🧠 reaction fires when at least one fact is extracted
- [ ] 📅 reaction fires when at least one fact contains a temporal reference
- [ ] No blocking: `runImplicitExtraction` returns as soon as job is published
- [ ] Works for both active (home channel) and passive (non-home) extraction paths
- [ ] No-op when `REDIS_URL` unset — `publishInferredMemory` already handles this gracefully

## Approach

`runImplicitExtraction` currently loops over facts calling `addImplicit` per fact — synchronous coalesce + file write for each one. Replace the loop with a single `publishInferredMemory(personaId, facts, requestId)` call.

The coalesce/contradiction logic moves to the worker reconciliation pass (Feature #6). For now the worker just inserts raw facts into `memory_staging`.

**Temporal detection** — `detectTemporalExpiry` runs in the bot before publishing (already exported from `memory-store.js` in Feature #4). If any fact returns a non-null expiry, fire 📅. This keeps the UX reaction immediate without waiting for the worker.

**🧠 reaction** — fires whenever `facts.length > 0`. Previously only fired when a fact was genuinely new (not already known). In the async path we don't know until reconciliation, so we fire optimistically. Acceptable UX trade-off.

## Tasks

1. [x] Update bot.js imports — add `publishInferredMemory`, `detectTemporalExpiry`; remove `addImplicit`
2. [x] Update `runImplicitExtraction` in bot.js — publish queue job, temporal check, reactions

## Edge Cases & Error Handling

- `publishInferredMemory` throws (Redis down): caught by existing try/catch in `runImplicitExtraction`, logged as `implicit_error` — same as current error handling
- Zero facts extracted: early return, no publish, no reaction — same as current
- `REDIS_URL` not set: `publishInferredMemory` is a no-op — facts silently dropped until Redis is configured

## Dependencies

- Feature #2 — `publishInferredMemory` in `queue-client.js`; worker inserts into `memory_staging`
- Feature #4 — `detectTemporalExpiry` exported from `memory-store.js`

## Open Questions

_(none)_
