# Feature: Random Message Injection

## Summary
Bot randomly sends an unprompted message to the gweeod channel at a random interval between 4 and 8 hours, generated through the full persona pipeline.

## Acceptance Criteria
- [x] Bot sends an unprompted message to gweeod at a random interval between 4–8 hours
- [x] Message is generated via the existing RAG + persona pipeline (not sent verbatim)
- [x] Seed prompt is: "Matt aggressively asks who wants to game"
- [x] Timer resets on bot restart (no persistence required)
- [x] Injection does not interfere with normal mention-based response flow

## Approach
On `ClientReady`, schedule a self-rescheduling `setTimeout` that fires after a random delay between 4 and 8 hours. Each time it fires, locate the gweeod channel by name, run the RAG pipeline with the seed message as the user prompt, post the result, then schedule the next injection with a new random delay. All logic lives in `bot.js` — no new modules needed.

## Tasks
1. [x] Add `scheduleInjection()` function to `bot.js` — picks random delay, calls itself recursively via `setTimeout`
2. [x] Inside the injection, find the gweeod channel across all guilds the bot is in
3. [x] Run `retrieve` + `loreSearch` + `buildSystemPrompt` + `generate` with the seed message
4. [x] Post the generated message to the gweeod channel
5. [x] Call `scheduleInjection()` at the end of `ClientReady`

## Edge Cases & Error Handling
- Gweeod channel not found (bot not in a server with that channel): log and skip, still reschedule
- Pipeline error during injection: log and skip, still reschedule
- Bot is in multiple guilds with a gweeod channel: inject into all of them

## Dependencies
- `retrieve`, `loreSearch` from `../rag/retrieve.js` (already imported)
- `generate`, `buildSystemPrompt` from `../rag/generate.js` (already imported)
- `retrieveLore`, `getDirectives`, `retrieveDiscord` from lore-store/discord-log (already imported)

## Open Questions
- None
