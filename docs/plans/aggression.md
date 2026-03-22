# Feature: Aggression

## Summary

Binary aggressive mode that triggers when conversation touches provocation topics, injecting frustration/anger/indignation into Matt's responses for 2–3 replies before cooling down.

## Provocation Topics

- New York City
- George Washington
- Boston racism
- Israel
- Joe Biden
- Hillary Clinton
- Hunter Biden

## Acceptance Criteria

- [ ] Incoming messages are classified via gpt-4o-mini for provocation topic detection
- [ ] Classification catches indirect/contextual references, not just keywords
- [ ] When triggered, Matt's response shows clear frustration, anger, and indignation
- [ ] Aggression carries over for 2–3 replies after the trigger, then cools down
- [ ] Aggression modifier is injected into the system prompt (not a separate generation path)
- [ ] Generation params are adjusted during aggression (higher max_tokens, temperature)
- [ ] Works in both gweeod and mention-based channels
- [ ] Does not interfere with existing features (chipple, remember, read, etc.)

## Approach

Follow the existing pattern: lightweight LLM classification → conditional prompt injection → adjusted generation params.

**Detection:** A gpt-4o-mini call receives the user message + recent conversation context and returns `{triggered, topic}`. The call runs in parallel with retrieval (no added latency on the critical path). Recent context is included so the classifier can resolve indirect references ("the city", "that laptop thing").

**State:** A per-channel Map tracks aggression state: `{topic, remainingReplies}`. When triggered, `remainingReplies` is set to a random value of 2 or 3. Each bot reply in that channel decrements the counter. When it hits 0, aggression clears. A new trigger during an active aggression window resets the counter.

**Prompt injection:** When aggression is active, an `## Aggression` block is injected into the system prompt before `## Final Instruction`. It instructs the model to respond with frustration and indignation about the specific topic, stay heated but coherent, and not break character.

**Generation params:** During aggression, `max_tokens` increases from 300 → 500 (rants run longer) and `temperature` increases from 0.8 → 0.95 (less filtered).

## Tasks

1. [ ] Add `classifyAggression(userMessage, conversationContext)` function in a new file `src/rag/aggression.js` — calls gpt-4o-mini, returns `{triggered, topic}`
2. [ ] Add per-channel aggression state tracking in `bot.js` — Map of `channelId → {topic, remainingReplies}`
3. [ ] Wire classification into the main message handler in `bot.js` — run in parallel with retrieval, check/update state
4. [ ] Add aggression prompt block to `buildSystemPrompt()` in `generate.js` — new optional parameter for aggression context
5. [ ] Adjust generation params in `generate()` — accept optional overrides for `max_tokens` and `temperature`
6. [ ] Test with `test-rag.js` or manual Discord testing — verify detection, prompt injection, carry-over, and cooldown

## Edge Cases & Error Handling

- **Classification fails/times out:** Fall back to non-aggressive response. Aggression is enhancement, not core — never block a reply.
- **Multiple topics in one message:** Classifier picks the strongest one. Only one aggression state per channel at a time.
- **Chipple overlap:** Chipple check runs first (existing behavior). If chipple triggers, aggression classification is skipped.
- **Commands (remember, forget, read, list memory):** These short-circuit before the main handler. Aggression does not apply to command responses.
- **Bot reply decrements even if the reply wasn't aggressive:** If the bot replies to a different user in the channel during the aggression window, it still decrements. This prevents stale aggression state.

## Dependencies

- OpenAI API (gpt-4o-mini for classification — already used elsewhere)
- No new packages required

## Open Questions

None.
