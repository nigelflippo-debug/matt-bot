# Feature: Confidence System

## Summary
Make confidence scores meaningful — retrieved facts are weighted by confidence, provisional entries decay over time, and `list memory` surfaces confidence visually.

## Acceptance Criteria
- [ ] Retrieved lore facts are reranked by `vectorScore * confidence` so higher-confidence entries surface first
- [ ] Provisional entries decay linearly from 0.6 → 0.3 over their 30-day lifespan (updated at startup alongside `pruneExpired`)
- [ ] Entries that decay to 0.3 or below are pruned at startup (not injected, not worth keeping)
- [ ] Explicit facts and directives (confidence 1.0, source `"explicit"`) are never decayed
- [ ] `list memory` summary line includes a confidence breakdown (high / medium / low counts)
- [ ] JSON output from `list memory` is sorted by confidence descending

## Approach

### 1. Retrieval weighting
`retrieveLore()` currently returns Vectra results sorted by raw vector similarity. After fetching, multiply each result's score by its `confidence` and re-sort. Simple one-liner change — no schema or index changes needed.

Threshold buckets:
- High: >= 0.8
- Medium: 0.5–0.8
- Low: < 0.5 (these are near expiry via decay anyway)

### 2. Confidence decay
Run `applyDecay()` at startup, after `pruneExpired()`. Only affects entries where `source === "bot-inferred"` and `category === "provisional"` — never touches explicit facts, directives, or episodics.

Decay formula (linear over lifespan):
```
age = (now - addedAt) in days
decayed = 0.6 - (age / 30) * 0.3   → ranges from 0.6 (day 0) to 0.3 (day 30)
confidence = max(0.3, decayed)
```

Entries at or below 0.3 are pruned (same mechanism as `pruneExpired`). This means unconfirmed provisionals naturally fade and disappear without needing the hard 30-day expiry to do all the work.

Returns count of entries decayed and pruned — logged at startup.

### 3. Display
`getAllLore()` already returns all entries. Changes in `bot.js` `list memory` handler:
- Sort entries by confidence descending before building the JSON output
- Add confidence breakdown to the summary line: e.g. `**12 entries** (3 directive, 6 fact, 2 episodic, 1 provisional) — 9 high, 2 medium, 1 low`

## Tasks
1. [x] Add `applyDecay()` to `lore-store.js` — decay provisionals with `source === "bot-inferred"`, prune at <= 0.3, return `{ decayed, pruned }`
2. [x] Call `applyDecay()` at startup in `bot.js` after `pruneExpired()`, log result
3. [x] Update `retrieveLore()` — multiply vector score by confidence, re-sort before returning
4. [x] Update `list memory` handler in `bot.js` — sort by confidence desc, add confidence breakdown to summary line
5. [ ] Test: verify `list memory` shows sorted output and correct breakdown counts
6. [ ] Test: verify a bot-inferred provisional's confidence drops at startup after simulating age (set `addedAt` to 20 days ago in lore.json)
7. [ ] Test: verify explicit facts (source `"explicit"`) are not decayed

## Edge Cases & Error Handling
- `addedAt` missing or unparseable → skip decay for that entry (treat as age 0)
- Entries already at confidence <= 0.3 at first decay run → pruned immediately
- `retrieveLore` with all confidence 1.0 entries → sort is stable, no visible change
- Decay prune removes an entry that was embedded in Vectra → mark for re-index (or just let `embedPendingLore` handle it next query — it only embeds, doesn't clean up deleted entries; tolerable since deleted entries won't be in lore.json so ID lookup returns undefined)

## Dependencies
- `implementations/rag/lore-store.js` — `applyDecay`, `retrieveLore` changes
- `implementations/discord-bot/bot.js` — startup call, `list memory` display

## Open Questions
- None
