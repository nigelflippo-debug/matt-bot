# Feature: Confidence Decay for Bot-Inferred Memories

## Summary

Adds a weekly scheduled pass that decays confidence on bot-inferred memories not
recently accessed. Memories that haven't been read in 7+ days lose 10% confidence
each week, floored at 0.1. This prevents stale inferences from staying high-confidence forever.

## Scope

**In scope:**
- `runDecay()` in `src/memory-worker/maintenance.js`
- Schedule weekly from `worker.js` using `setInterval`

**Out of scope:**
- Decaying explicit memories (source='explicit')
- Pruning on confidence threshold (that's Feature #11)

## Acceptance Criteria

- [ ] `runDecay()` runs a single UPDATE on bot-inferred memories
- [ ] Only affects rows with `last_accessed_at < now() - interval '7 days'`
- [ ] Confidence floors at 0.1 (`GREATEST(0.1, confidence * 0.9)`)
- [ ] Logs rows affected at end of pass

## Tasks

1. [x] Create `src/memory-worker/maintenance.js` with `runDecay()`
2. [x] Schedule weekly in `worker.js`

## Dependencies

- Feature #3 — memories table exists with confidence column

## Open Questions

_(none)_
