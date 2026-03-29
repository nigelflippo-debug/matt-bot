# Patch Notes — 2026-03-28

## Code Quality Refactor

No behavior changes — this was an internal cleanup pass to reduce spaghetti and make the code easier to work with.

### What changed

**Entity summary logic is now in one place**
- Previously the code that fetches a person's memories and asks GPT to summarise them existed in two separate files and had drifted slightly out of sync
- Extracted to `src/rag/entity-summary.js` — single source of truth for both the per-person rebuild (triggered after new memories) and the bulk backfill (worker startup)

**`buildSystemPrompt` is no longer a 12-argument function**
- The main function that assembles the system prompt used to take 12 positional arguments — easy to get them in the wrong order, painful to add a new one
- Now takes a named context object: `buildSystemPrompt(base, { results, memories, directives, ... })`
- Each section of the prompt (rules, examples, memories, aggression, etc.) is now its own small pure function, composed together in a single pipeline instead of a flat wall of `if` blocks

**Bot command handlers extracted**
- The `remember:`, `list memory`, `forget:`, and `read:` command branches used to live inline inside the 500-line message handler
- Each is now a named async function (`handleRemember`, `handleListMemory`, `handleForget`, `handleRead`) — the main handler dispatches to them in 4 lines

**Bug fix: debug output no longer crashes**
- The `--debug` flag response referenced an undefined variable (`retrievedFacts`) — this would have thrown silently at runtime
- Fixed to use the correct variable (`retrievedMemories`)

**Misc cleanup**
- Removed 3 redundant `Promise.resolve()` wrappers that were wrapping already-async functions for no reason
