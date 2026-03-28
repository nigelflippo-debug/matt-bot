# Feature: Redlock on Reconciliation Pass

## Summary

This feature wraps the reconciliation pass with a distributed Redis lock so concurrent workers can't race on the same persona's staging entries.

## Scope

**In scope:**
- Add `redlock` to `src/memory-worker/package.json`
- Update `worker.js` — acquire Redlock on `reconcile:{persona_id}` before calling `reconcile()`; skip if already locked
- Fix `reconcileRow` to return an outcome string — eliminates the before/after COUNT queries used for tallying

**Out of scope:**
- Multi-worker scaling — single worker is current architecture; Redlock is a safety measure

## Acceptance Criteria

- [ ] `reconcile(persona_id)` is never called concurrently for the same persona
- [ ] If lock is already held, the pass is skipped (logged); staging rows picked up by the running pass
- [ ] Lock TTL is 60 seconds — longer than any expected reconciliation run
- [ ] `reconcileRow` returns `"promoted" | "merged" | "duplicate" | "skipped"` instead of triggering COUNT queries
- [ ] Summary log reports `{ promoted, merged, duplicate, skipped, errors }`

## Approach

`redlock` v5 with `retryCount: 0` — acquire or skip immediately, never queue. Lock key: `reconcile:{persona_id}`. Separate ioredis client for Redlock (not the BullMQ one, which has `maxRetriesPerRequest: null`).

Counter simplification: `reconcileRow` returns its outcome directly. The `reconcile()` loop tallies outcomes from return values — no extra DB round-trips.

## Tasks

1. [x] Make `reconcileRow` return outcome string; update `reconcile()` tally to use it
2. [x] Add `redlock@^5.0.0-beta.2` to `src/memory-worker/package.json` + `npm install`
3. [x] Update `worker.js` — Redlock client, acquire/skip wrapper around `reconcile()`

## Dependencies

- Feature #6 — `reconcile.js` exists, `reconcile(personaId)` callable
- Redis (existing)

## Open Questions

_(none)_
