# Feature: Lore Store v2 — Classification + Semantic Retrieval

## Summary
Replace static full-lore injection with classified storage and semantic retrieval: directives (behavioral rules) are always injected; facts (everything else) are embedded lazily and retrieved by relevance at query time.

## Acceptance Criteria
- [ ] Each lore entry has a stable `id`, `category` (`directive` | `fact`), and `embedded` flag
- [ ] LLM classifies incoming entries as `directive` or `fact` before coalescing
- [ ] Directives are always injected into the system prompt (hard cap: 20)
- [ ] Facts are embedded on first query after write (lazy), stored in `data/index-lore/`
- [ ] Top-K relevant facts are retrieved per query and injected as context
- [ ] Merged or updated entries reset `embedded: false` and re-embed on next query
- [ ] Deleted entries are removed from the Vectra index
- [ ] Existing lore.json entries are migrated (assigned id + category + embedded) on first load
- [ ] `consolidateLore` continues to work, preserving categories
- [ ] No regression in `remember:` / `forget:` / `list lore` / `consolidate lore` commands

## Approach

### Two categories
- **directive** — behavioral rules the bot must follow: word bans, style rules, response format instructions. Always injected (small set, cap 20).
- **fact** — everything else: group lore, personal facts, ephemeral notes. Semantically retrieved (top K per query).

### Classification
New LLM call in `addLore` before the existing coalesce step. Simple prompt: is this a behavioral instruction for the bot, or a fact/memory? Returns `directive` or `fact`.

### Lazy embedding
Each `fact` entry has `embedded: false` on write/update. A new `embedPendingLore()` function is called at the start of each bot query:
- Reads lore.json, finds entries with `category: "fact"` and `embedded: false`
- Embeds them with `text-embedding-3-small`
- Upserts into a new Vectra index at `data/index-lore/`
- Sets `embedded: true` in lore.json
- No-ops if nothing is pending

### Lore retrieval
New `retrieveLore(query, k)` function:
- Embeds the query
- Searches `data/index-lore/`
- Returns top K entries

### Stable IDs
On write, each new entry gets a unique id (`lore_<timestamp>_<4-char-random>`). Used as the Vectra item id. On merge, the existing entry's id is preserved. On delete, the Vectra item is removed by id.

### Migration
`load()` detects entries missing `id`/`category`/`embedded` and backfills:
- Assigns a stable id
- Defaults `category` to `"fact"` (existing entries are presumed facts)
- Sets `embedded: false` (forces re-embedding)
- Writes migrated entries back to disk

## Tasks
1. [x] Add `id`, `category`, `embedded` fields + migration in `load()` / `save()`
2. [x] Add LLM classification step in `addLore` (before coalesce)
3. [x] Add `embedPendingLore()` — lazy batch embed, upsert to `data/index-lore/`
4. [x] Add `retrieveLore(query, k)` — embed query, search index, return entries
5. [x] Add `getDirectives()` — return all directive entries
6. [x] Update `removeLore` to delete from Vectra index when `embedded: true`
7. [x] Update `consolidateLore` to preserve categories on rebuilt entries
8. [x] Update `generate.js` `buildSystemPrompt` — replace `staticLore` param with `retrievedFacts` and `directives`
9. [x] Update `bot.js` — call `embedPendingLore()` before retrieval, pass `retrievedFacts` + `directives` to `buildSystemPrompt`, remove `getAllLore()`

## Edge Cases & Error Handling
- Empty lore index (no fact entries yet): `retrieveLore` returns `[]`, bot falls back gracefully
- Vectra index doesn't exist: create it on first `embedPendingLore` run
- Directive cap (20) reached: use the same capped response, but track directive count separately from fact count so lore cap (100 facts) isn't consumed by directives
- Classification LLM failure: default to `"fact"` so nothing is lost
- Deleted entry not in index (not yet embedded): skip silently

## Dependencies
- Vectra (`LocalIndex`) — already in use for pair/window indexes
- OpenAI `text-embedding-3-small` — already in use
- OpenAI `gpt-4o-mini` — already in use for coalesce/consolidate

## Open Questions
- None

## Lore retrieval K value
Start at K=5 (same as RAG). Tune based on prompt token budget and quality.
