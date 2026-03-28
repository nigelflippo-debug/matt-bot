# Feature: Worker Pruning (Expired + Stale)

## Summary

Adds daily scheduled cleanup that removes expired memories and stale bot-inferred
memories that have never been accessed. Replaces the startup-time pruning that was
removed in Feature #8.

## Scope

**In scope:**
- `runPruning()` in `src/memory-worker/maintenance.js`
- Delete expired rows: `expires_at < now()`
- Delete stale rows: `source = 'bot-inferred'`, `last_accessed_at IS NULL`, `added_at < now() - interval '30 days'`
- Schedule daily from `worker.js`

**Out of scope:**
- Pruning on confidence threshold
- Pruning explicit memories

## Acceptance Criteria

- [ ] `runPruning()` deletes expired and stale rows in two queries
- [ ] Logs counts for each deletion
- [ ] Scheduled daily via `setInterval` in worker.js

## Tasks

1. [x] Add `runPruning()` to `src/memory-worker/maintenance.js`
2. [x] Schedule daily in `worker.js`

## Dependencies

- Feature #3 — memories table exists
- Feature #10 — maintenance.js exists (co-authored)

## Open Questions

_(none)_
