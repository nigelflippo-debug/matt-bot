# Feature: Memory Model Simplification

## Summary
Collapse the four-category memory model (fact/episodic/provisional/directive) into two: memory and directive. Remove the provisional confidence pipeline. Add entity profiles (per-person consolidated views) and access-based salience (memories that get used stay relevant). All remembered things are just memory — permanent or expiring.

## Feature Statement
> This refactor simplifies the memory system so that everything the bot remembers is called "memory", with optional expiry for temporary things, and behavioral rules remain "directives". The provisional → reinforced → promoted confidence pipeline is removed.

## Scope

**In scope:**
- Rename `fact`, `episodic`, `provisional` → `memory` everywhere
- Remove `applyDecay()` and the provisional lifecycle (reinforce/promote)
- Simplify `addImplicit` — dedup check, then write straight to memory
- Simplify `splitOrClassify` — no `episodic` category; "for now" signals just set `expiresAt`
- Remove `addUserAsserted` — untrusted user `remember:` just goes through `addLore` at lower trust
- Remove `softFacts` injection split in generate.js — everything retrieved is just memory
- Update emoji reactions in bot.js — drop 🔄 (reinforced) and 🤔 (provisional)
- Migration in `load()` for existing entries
- Update CLAUDE.md

**In scope (enterprise patterns):**
- Entity profiles — per-person consolidated memory view, built on retrieval, used for generation context
- Access-based salience — track `lastAccessedAt` on each memory entry; use access recency alongside semantic similarity in retrieval ranking

**Out of scope:**
- Changing directives in any way
- Renaming `lore-store.js` or file paths (low value, high noise)
- Full knowledge graph / relationship modelling (overkill for friend group scale)
- Structured `{ attribute, value }` triple extraction (high implementation cost, low gain here)

## Acceptance Criteria (base simplification)
- [ ] All memory entries use category `"memory"` (directives unchanged)
- [ ] Existing entries migrated on load — no data loss
- [ ] `remember:` stores to memory (permanent or expiring based on temporal detection)
- [ ] `remember for now:` stores to memory with 7-day expiry
- [ ] Implicit extraction writes directly to memory (with dedup)
- [ ] `applyDecay` removed from startup
- [ ] `softFacts` / provisional injection removed from generate.js
- [ ] Reactions simplified — only 🧠 (new memory) and 📅 (temporal) remain
- [ ] `list memory` output reflects simplified categories
- [ ] Bot still responds correctly, no regressions

## Acceptance Criteria (entity profiles)
- [ ] `retrieveLore` builds a per-person profile when a named person appears in the query — returns their memories consolidated, not just top-K scattered facts
- [ ] Profile is used in generation the same way retrieved facts are today
- [ ] No-person queries fall back to current semantic retrieval behavior unchanged

## Acceptance Criteria (access-based salience)
- [ ] Each memory entry has a `lastAccessedAt` field, updated whenever the entry is retrieved and injected into a prompt
- [ ] `retrieveLore` ranking blends semantic similarity with recency of access — frequently used memories surface higher
- [ ] Memories never accessed within 180 days (and not explicitly user-added) are candidates for pruning at startup

## Approach

### Category model
Before: `fact` | `episodic` | `provisional` | `directive`
After:  `memory` | `directive`

Temporal expiry (`expiresAt`) is what distinguishes "remember for now" from permanent memory — not the category. This was already true; we're just making it the only mechanism.

### Migration (in `load()`)
```js
if (["fact", "episodic", "provisional"].includes(entry.category)) {
  entry.category = "memory";
  dirty = true;
}
```
Existing `provisional` entries that were bot-inferred: keep their `expiresAt` if set, otherwise give them a short expiry (30 days) so they age out naturally rather than becoming permanent noise.

### `splitOrClassify` simplification
Remove `episodic` from the category list. The prompt becomes:
- `"directive"` — behavioral rules
- `"memory"` — everything else

Temporal signals ("for now", "tonight", etc.) are detected by `detectTemporalExpiry` downstream — they don't need a separate category.

### `addImplicit` simplification
Current: provisional → reinforced → promoted (3-stage pipeline)
New: dedup check via `coalesce` → if new, write to `memory` directly

Rationale: the coalesce step already prevents duplicates. The 3-stage pipeline was meant to build confidence over repeated sightings but in practice the retrieval quality matters more than the confidence score.

### `addUserAsserted` removal
Currently used for untrusted `remember:` — stores as provisional confidence 0.3.
New behavior: untrusted `remember:` → same as trusted but confidence is implicit in it being memory. The distinction was more conceptual than functional. Remove `addUserAsserted`, route everything through `addLore`.

### generate.js
Remove the `personalFacts` / `softFacts` / `backgroundFacts` split.
New: retrieved memory goes into one block: `"Things you know"`.
URL-imported facts still get their own block (`"Background knowledge"`) since that distinction is about framing, not confidence.

### Reactions
- 🤔 (provisional added) → 🧠 (memory noted) — same emoji as promotion was
- 🔄 (reinforced) → removed entirely
- 🧠 (promoted) → 🧠 (memory noted, same)
- 📅 (temporal) → keep

### `lifespan` field
Was: `permanent` | `temporary` | `long-lived`
Can drop — `expiresAt !== null` is the canonical signal. Remove from new writes, keep in load() for back-compat (just ignore it).

### `confidence` field
Keep on entries for now — url-import facts use it and it's useful metadata. But stop using it for retrieval ranking in `retrieveLore` (the coalesce/dedup pipeline handles quality instead).

### Entity profiles
When the retrieval query contains a person's name (e.g. "what's Reed up to"), instead of returning K scattered facts from the flat store, gather all memories tagged `person: "Reed"` and return them as a consolidated block. This mirrors how enterprise systems maintain structured entity records.

Implementation: in `retrieveLore`, detect a named person in the query (already doing this for boost — extend it). If a person match is found, pull all their tagged memories and inject them as a profile block in generate.js, separate from the general memory block.

The profile block framing: `"What you know about [person]"` — more focused than the general facts block. Retrieval still falls back to semantic search for non-person queries or queries where no person memories exist.

### Access-based salience
Add `lastAccessedAt` (ISO timestamp, default null) to each memory entry. Update it in `retrieveLore` whenever an entry is returned. Use it in ranking:

```
score = semanticSimilarity * 0.7 + accessRecency * 0.3
```

Where `accessRecency` = 1.0 for accessed within 7 days, scaling down to 0.0 at 180 days.

At startup (alongside `pruneExpired`), prune bot-inferred memory entries that:
- Have never been accessed (`lastAccessedAt` is null)
- Are older than 180 days
- Were not explicitly user-added (`source !== "explicit"`)

This prevents the store from accumulating inert facts that were extracted once and never relevant.

## Tasks

### Base simplification
1. [ ] Update `load()` — migrate `fact`/`episodic`/`provisional` → `memory`, handle provisional expiry
2. [ ] Update `splitOrClassify` prompt — remove `episodic`, use `memory`
3. [ ] Simplify `addImplicit` — remove 3-stage pipeline, write straight to memory
4. [ ] Remove `addUserAsserted` — update `remember:` in bot.js to use `addLore` for all users
5. [ ] Remove `applyDecay` from lore-store.js and startup call in bot.js
6. [ ] Update `embedPendingLore` — filter by `memory` instead of `fact`/`episodic`/`provisional`
7. [ ] Update `deduplicateLore` — filter by `memory`
8. [ ] Update `addLore` / `addSingle` — use `memory` category, drop `lifespan` field
9. [ ] Update generate.js — remove `softFacts` split, keep url-import background block
10. [ ] Update bot.js — simplify reactions, remove `softFacts`, remove `applyDecay` call
11. [ ] Update CLAUDE.md — reflect simplified model

### Entity profiles
12. [ ] Extend `retrieveLore` — detect named person in query, pull all their tagged memories as a profile
13. [ ] Update generate.js — inject person profile as its own `"What you know about [person]"` block when present
14. [ ] Fallback: semantic retrieval unchanged when no person match

### Access-based salience
15. [ ] Add `lastAccessedAt` field — backfill null in `load()` migration
16. [ ] Update `retrieveLore` — set `lastAccessedAt` on returned entries, blend access recency into ranking
17. [ ] Add `pruneStale` to startup — remove bot-inferred memories never accessed after 180 days

### Final
18. [ ] Test: `remember:`, `remember for now:`, implicit extraction, list memory, forget:, person queries, salience ranking

## Edge Cases & Error Handling
- **Existing provisional entries** — if `expiresAt` is set, keep it; if null, set 30-day expiry so they age out
- **Existing episodic entries** — already have `expiresAt`, keep it; they'll prune naturally
- **Back-compat in load()** — all migrations additive, never destructive
- **`reinforcedAt` field on old entries** — can leave in place, just stop writing it
- **Entity profile with many memories** — cap profile injection at 15 entries to avoid token bloat; semantic sort within profile
- **Person name ambiguity** — if query mentions multiple people, build a profile for the most prominent one; fall back to semantic search for others
- **`lastAccessedAt` on old entries** — backfill null; null entries treated as never accessed for salience scoring
- **Stale pruning safety** — never prune entries with `source: "explicit"` or `source: "url-import"` regardless of access recency

## Dependencies
- No new packages
- `lore.json` migration handled in-process at startup via `load()`

## Open Questions
None.
