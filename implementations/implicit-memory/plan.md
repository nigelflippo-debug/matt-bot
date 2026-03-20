# Feature: Implicit Memory

## Summary
The bot passively observes Discord conversations and automatically extracts memory-worthy content — facts, opinions, preferences, takes — storing them as provisional lore entries that are promoted to permanent facts when confirmed by repetition.

## Acceptance Criteria
- [ ] Bot runs extraction on all qualifying messages (gweeod + explicit mentions), not just responses to mentions
- [ ] Command messages (`remember:`, `forget:`, `list memory`, `consolidate memory`) are excluded from extraction
- [ ] Messages under 30 characters or with no apparent substantive content are skipped (noise floor)
- [ ] Extraction covers anything conversationally meaningful: personal facts, opinions, preferences, sports, politics, interests — not just biographical facts
- [ ] Extracted content stored as `provisional` (confidence 0.6, source `"bot-inferred"`, expires 30 days)
- [ ] If an extracted fact matches an existing provisional → that provisional is promoted to `fact` (permanent, confidence 1.0)
- [ ] If an extracted fact matches an existing fact → silently skipped (already known)
- [ ] Extraction runs as fire-and-forget — never delays or blocks the bot's reply
- [ ] All extraction decisions are logged (extracted facts, actions taken per fact)
- [ ] Provisionals are visible in `list memory` output (already the case — `getAllLore()` returns all)

## Approach

### Extraction
A new `extractImplicit(conversationText)` function in `lore-store.js` calls gpt-4o-mini with a broad extraction prompt. Unlike the `remember:` flow (which stores what the user explicitly says), implicit extraction guesses what's worth remembering from natural conversation. The prompt should capture:
- Personal facts (jobs, relationships, locations, health)
- Concrete plans or upcoming events
- Opinions, preferences, takes on sports/politics/media/games
- Anything the group would consider "classic X" — patterns in who someone is

### Storing + promotion via coalesce
A new `addImplicit(text, source)` function uses the existing `coalesce()` logic twice:
1. Check against existing `fact` entries → if covered, skip
2. Check against existing `provisional` entries → if matched (skip or merge), promote that provisional to fact
3. If no match anywhere → add as new provisional (expires 30 days)

**This requires coalesce to return an index on `skip`** (currently it doesn't). Update `COALESCE_SYSTEM` to always include `"index":<n>` in the skip response. This is backward-compatible — callers that ignore the index continue to work.

### Triggering in bot.js
After `message.reply()`, build a short conversation context (last 3 prior messages + current message) and fire `runImplicitExtraction(context, requestId)` without awaiting. Gate: `userMessage.length >= 30`. Do not fire on command messages (those return early before reaching the reply code, so they're naturally excluded).

For messages the bot processes but doesn't reply to (none currently — gweeod handles everything, other channels only respond on mention), no extraction needed since those don't reach the reply path.

### Cost estimate
- gpt-4o-mini extraction call per qualifying message: ~200 tokens in / ~50 out ≈ $0.00003
- Per coalesce check (up to 2 per extracted fact): ~100 tokens each ≈ $0.00002
- For a low-traffic private group (~50 qualifying messages/day): ~$0.003/day

## Tasks

1. [x] Update `COALESCE_SYSTEM` in `lore-store.js` — add `"index":<n>` to the `skip` response format
2. [x] Add `EXTRACT_SYSTEM` prompt constant — broad extraction covering facts, opinions, preferences, takes
3. [x] Add `extractImplicit(conversationText)` export — LLM call, returns `string[]`
4. [x] Add `addImplicit(text, source)` export — coalesce against facts then provisionals, store or promote
5. [x] Add `runImplicitExtraction(conversationContext, requestId)` async helper in `bot.js`
6. [x] Wire up in `bot.js` — fire after `message.reply()` with 30-char gate
7. [x] Import `extractImplicit`, `addImplicit` in `bot.js`
8. [ ] Test: send a qualifying message, verify extraction fires and provisional appears in `list memory`
9. [ ] Test: send the same fact a second time (in a later message), verify provisional is promoted to fact
10. [ ] Test: send a short message (< 30 chars), verify no extraction fires
11. [ ] Test: send a `remember:` command, verify no extraction fires (returns early)

## Edge Cases & Error Handling
- Extraction LLM returns `[]` for most messages — that's expected and fine; log `found: 0` and stop
- Coalesce LLM call fails → `addImplicit` catches and logs; never blocks the reply path
- `extractImplicit` call fails → `runImplicitExtraction` catches at the top level; bot is unaffected
- Provisional expires before being confirmed → pruned at startup via existing `pruneExpired()` — no action needed
- Many provisionals accumulate → coalesce still works (O(n) LLM call over the provisional list); acceptable for low-traffic group
- Skip response without index from coalesce (legacy) → treat as "unknown match", fall through to add as new provisional

## Dependencies
- `implementations/rag/lore-store.js` — primary changes
- `implementations/discord-bot/bot.js` — wire-up
- Existing `coalesce()`, `addSingle()`, `pruneExpired()` in lore-store — no API changes, only coalesce prompt update
- OpenAI gpt-4o-mini (already in use)

## Open Questions
- None
