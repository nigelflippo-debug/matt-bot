# Feature: Memory Governance

## Summary
Upgrade the lore store with structured metadata, an extended type system, lifespan/expiry, and confidence scoring — fully backward compatible with a migration that backfills all existing entries.

## Acceptance Criteria
- [ ] All existing entries survive migration with correct defaults
- [ ] Four memory types supported: `directive`, `fact`, `episodic`, `provisional`
- [ ] Each entry has: `confidence`, `source`, `lifespan`, `expiresAt?`, `scope`
- [ ] Episodic entries with a past `expiresAt` are pruned at startup
- [ ] Provisional entries are stored but not injected into the prompt
- [ ] `remember for now: X` syntax stores an episodic entry (expires in 7 days)
- [ ] Existing `forget` and `consolidate lore` commands work as before
- [ ] Existing `directive` and `fact` entries behave identically to pre-migration

## Approach

Extend `lore-store.js` in place. New fields are added to the JSON schema; migration backfills existing entries on first `load()` — same pattern as the current v2 migration. No new infrastructure, same Vectra index, same `lore.json`.

### Schema extension

```json
{
  "id": "lore_...",
  "text": "...",
  "category": "fact | directive | episodic | provisional",
  "confidence": 1.0,
  "source": "explicit | bulk-import | bot-inferred",
  "lifespan": "permanent | long-lived | temporary",
  "expiresAt": null,
  "scope": "global",
  "embedded": false,
  "addedBy": "...",
  "addedAt": "...",
  "updatedAt": null
}
```

### Migration defaults for existing entries

| Field | Default |
|-------|---------|
| `confidence` | `1.0` |
| `source` | `"bulk-import"` if `addedBy === "consolidation"`, else `"explicit"` |
| `lifespan` | `"permanent"` |
| `expiresAt` | `null` |
| `scope` | `"global"` |
| `updatedAt` | `null` |

### Type behavior

| Type | Prompt injection | Default lifespan | Default confidence |
|------|-----------------|------------------|--------------------|
| `directive` | Always (system prompt) | permanent | 1.0 |
| `fact` | Retrieved semantically | permanent | 1.0 |
| `episodic` | Retrieved semantically | temporary (7 days) | 0.8 |
| `provisional` | Not injected | long-lived | 0.6 |

### Expiry

At startup, `pruneExpired()` removes entries where `expiresAt < now`. Pruned count is logged. Called from `bot.js` before the first query.

### `remember for now:` syntax

If the text starts with `for now:` or similar, `splitOrClassify` returns `episodic` with `lifespan: temporary`. Bot sets `expiresAt` to 7 days from now. Example:

> `@MattBot remember for now: Matt is visiting Boston this weekend`

### What is NOT in scope

- Implicit extraction (bot auto-inferring memory from conversations) — future feature
- Promotion-by-repetition — depends on implicit extraction
- Scope system (everything is global for this use case)
- Confidence decay / forgetting algorithm — manual prune via `forget` is sufficient

## Tasks

1. [x] Extend migration in `load()` — backfill `confidence`, `source`, `lifespan`, `expiresAt`, `scope`, `updatedAt` on all existing entries
2. [x] Update `splitOrClassify` — add `episodic` as valid category; detect "for now" hint in input text
3. [x] Add `pruneExpired()` — removes entries where `expiresAt` is set and in the past; logs count
4. [x] Update `addSingle` — set `confidence`, `source`, `lifespan`, `expiresAt` on new entries based on category
5. [x] Update `getDirectives` — provisional already excluded (filter is `category === "directive"`; no change needed)
6. [x] Update `embedPendingLore` — include `episodic`, skip `provisional`
7. [x] Update `consolidateLore` — preserve episodic/provisional entries; add governance fields to output entries
8. [x] Add `pruneExpired()` call to `bot.js` at startup (in `ClientReady`)
9. [ ] Test: add a `remember for now:` entry, verify episodic category + expiresAt set
10. [ ] Test: manually set `expiresAt` to past, restart bot, verify entry is pruned
11. [ ] Test: existing entries survive restart with all new fields backfilled

## Edge Cases & Error Handling

- Migration is additive only — never overwrite existing field values
- If `expiresAt` is malformed or unparseable, treat as non-expiring (log warning, don't prune)
- Provisional entries are silently excluded — no user-visible behavior change
- `consolidateLore` outputs fresh entries; preserve governance fields from source entries where possible (category → category, confidence → min of merged set)

## Dependencies

- `implementations/rag/lore-store.js` — primary changes
- `implementations/discord-bot/bot.js` — add startup prune call
- No new npm packages

## Open Questions

- None

## Follow-up: Implicit Extraction (next feature)

Once memory governance is shipped, build implicit extraction on top of it:
- Bot observes all channel messages (not just mentions)
- LLM extraction pass after each message: "is anything here memory-worthy?"
- Memory-worthy content stored as `provisional`, `confidence: 0.6`, `source: "bot-inferred"`
- Candidate buffer: same fact seen again → promoted to `fact` with higher confidence
- Never reinforced → expires naturally via episodic lifespan
- Governance types/expiry/confidence are the required primitives — implement those first
