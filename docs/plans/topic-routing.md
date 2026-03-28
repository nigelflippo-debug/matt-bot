# Feature: Topic Routing

## Summary
When a message arrives, each persona scores it against their own topic affinity (derived from their system prompt) and delays claiming proportionally — high-affinity bots claim immediately, low-affinity bots wait, so the most relevant persona wins the Redis race most of the time.

## Acceptance Criteria
- [ ] Each persona extracts topic keywords from their system prompt at startup via gpt-4o-mini (one-time call, cached in memory)
- [ ] High-affinity messages are claimed by the relevant persona significantly more often than random
- [ ] No-match messages (no persona has strong affinity) fall through to the default SET NX race with no delay
- [ ] Overlap (two personas both score high) degrades to the default SET NX race — no special handling required
- [ ] If affinity init fails (OpenAI error), all bots fall back to random claiming — no crash, no silent breakage
- [ ] Only applies to human messages in home channel; cross-talk (bot → bot) is unaffected

## Approach

**Keyword extraction at startup:** `initAffinity(systemPromptText)` calls gpt-4o-mini once, asking for a JSON array of topics/interests that characterize this persona. Cached in-module memory for the process lifetime. `baseSystemPrompt` is already loaded at startup in `bot.js` and passed in during `ClientReady`.

**Scoring:** `scoreMessage(text)` counts keyword hits (case-insensitive substring match) normalized by keyword count. Returns 0–1.

**Delay tiers:**
- score ≥ 0.4 → 0ms (high affinity, claim immediately)
- score 0.15–0.4 → 400ms (medium affinity)
- score < 0.15 → 1200ms (low/no match, let others go first)

**Overlap:** Two bots both scoring ≥ 0.4 both delay 0ms and race via SET NX as normal. No special handling.

**Placement:** Delay runs inside the Redis coordination block, after the recency check and before the SET NX call. Only on human messages.

## Tasks
1. [ ] Create `src/rag/topic-affinity.js` — `initAffinity(systemPromptText)`, `scoreMessage(text)`, `getDelayMs(score)`
2. [ ] Call `initAffinity(baseSystemPrompt)` in the `ClientReady` handler in `bot.js`
3. [ ] In the Redis coordination block (human messages only), score the message and `await sleep(getDelayMs(score))` before the SET NX call
4. [ ] Verify graceful fallback: if `initAffinity` fails or hasn't completed, `scoreMessage` returns 0 (no delay)

## Edge Cases & Error Handling
- OpenAI call fails at startup → log warning, affinity stays uninitialised → `getDelayMs` returns 0ms for all messages (random claiming preserved)
- Very short messages (1–3 words) → keyword hit count is noisy but acceptable for v1
- Keyword list is empty after extraction → treated as uninitialised, no delay applied
- `sleep` called with 0ms → `setTimeout(resolve, 0)`, no practical overhead
- Bot messages → skipped entirely, ancestry check handles cross-talk pacing

## Dependencies
- OpenAI API (gpt-4o-mini, one call per process startup)
- `baseSystemPrompt` available at `ClientReady` time in `bot.js`
- Redis coordination block already in place

## Open Questions
_(none — cleared to implement)_

## Completed
2026-03-25 — Keywords extracted via gpt-4o-mini at startup, cached in-process. Delay tiers: 0/400/1200ms. Affinity score logged per-message as `coord_affinity` for future observability. Init failure degrades to random claiming with no crash._
