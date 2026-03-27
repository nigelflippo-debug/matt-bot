# Feature: Source Weight Guard in Reconciliation

## Summary

Prevents bot-inferred facts from overwriting higher-confidence explicit memories.
The contradiction overwrite path in `reconcile.js` currently replaces any existing memory;
it should only replace when the new fact's source weight is >= the existing one.

## Scope

**In scope:**
- Add `source_weight` to `getSimilarMemories` SELECT
- Guard the contradiction overwrite: skip if `BOT_INFERRED_SOURCE_WEIGHT < target.source_weight`
- Log a `reconcile_weight_guard` event when overwrite is skipped

**Out of scope:**
- Changing source weight values or thresholds

## Acceptance Criteria

- [ ] `getSimilarMemories` returns `source_weight` on each candidate row
- [ ] Contradiction overwrite only fires when `BOT_INFERRED_SOURCE_WEIGHT >= target.source_weight`
- [ ] When guard fires, row is marked reconciled and outcome is `"skipped"`

## Tasks

1. [x] Add `source_weight` to SELECT in `getSimilarMemories`
2. [x] Add weight guard to contradiction overwrite block in `reconcileRow`

## Dependencies

- Feature #6 — reconcile.js exists

## Open Questions

_(none)_
