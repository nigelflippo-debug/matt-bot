# Feature: Coalesce Pre-filtering

## Summary
Before calling the LLM coalesce function, use vector similarity to narrow the candidate list to the top N most semantically similar entries — making duplicate detection O(1) instead of O(n) regardless of store size.

## Problem
`addSingle()` and `addImplicit()` both call `coalesce(text, sameCat)` where `sameCat` is every entry in that category. With 600 facts, every `remember:` command and every implicit extraction event sends a 600-line prompt to gpt-4o-mini. At ~5,000 entries this becomes slow and expensive. The fix is to pre-filter with embeddings first, then only coalesce against the top 20 most similar candidates.

## Acceptance Criteria
- [ ] `addSingle()` pre-filters same-category entries before calling `coalesce()` when count > threshold (20)
- [ ] `addImplicit()` pre-filters facts and provisionals before calling `coalesce()`
- [ ] Directives are exempt — always coalesce against the full list (capped at 20, pre-filtering would add latency for no benefit)
- [ ] Provisional entries are embedded into the lore index so they can be searched during pre-filtering
- [ ] Pre-filtering is a no-op when the candidate list is already <= threshold (avoids the embedding call cost for small stores)
- [ ] Correctness: pre-filtering should not cause legitimate merges or skips to be missed (top 20 by similarity is a safe window)
- [ ] No change to external behaviour — callers of `addLore`, `addImplicit` see identical results

## Approach

### Pre-filter helper (internal)
```js
async function preFilterCandidates(text, candidates, n = 20) {
  if (candidates.length <= n) return candidates;  // skip below threshold
  if (!(await loreIndex.isIndexCreated())) return candidates.slice(0, n);

  const embResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: [text],
  });
  const results = await loreIndex.queryItems(embResponse.data[0].embedding, n * 2);

  // Cross-reference results against our candidate list (correct category only)
  const candidateById = new Map(candidates.map((e) => [e.id, e]));
  const filtered = results
    .map((r) => candidateById.get(r.item.metadata.id))
    .filter(Boolean)
    .slice(0, n);

  // Fallback: if index doesn't have these entries yet, return first n candidates
  return filtered.length > 0 ? filtered : candidates.slice(0, n);
}
```

The helper embeds the new text, queries the lore index for top `n*2` results, then filters to only entries in the provided candidate list (ensuring we stay within the right category). Returns at most `n` candidates.

### Provisional entries in the lore index
Currently `embedPendingLore()` only embeds `fact` and `episodic`. Change the filter to also include `provisional`. This means:
- Provisionals get embedded on the next `embedPendingLore()` call (which runs at every bot query)
- Pre-filtering against provisionals in `addImplicit()` works correctly after the first query post-add
- One-query lag before a brand-new provisional is searchable — acceptable

When a provisional is promoted to fact (in `addImplicit`), `embedded` is already set to `false`, so it gets re-embedded as a fact on the next query. No change needed there.

### Changes to `addSingle()`
Replace:
```js
const result = await coalesce(text, sameCat);
```
With:
```js
const candidates = category === "directive" ? sameCat : await preFilterCandidates(text, sameCat);
const result = await coalesce(text, candidates);
```

Note: `coalesce` returns an index into the candidate list. When pre-filtering, the index refers to the filtered list, not `sameCat`. The existing merge logic uses `candidates[result.index]` to get the target entry's `id` — this still works correctly because we look up by id from `entries`.

### Changes to `addImplicit()`
Same pattern — call `preFilterCandidates` before each `coalesce` call:
```js
const factCandidates = await preFilterCandidates(text, facts);
const factResult = await coalesce(text, factCandidates);
// ...
const provCandidates = await preFilterCandidates(text, provisionals);
const provResult = await coalesce(text, provCandidates);
```

## Tasks
1. [x] Update `embedPendingLore()` — add `provisional` to the embedded categories filter
2. [x] Add `preFilterCandidates(text, candidates, n=20)` internal helper
3. [x] Update `addSingle()` — use `preFilterCandidates` for non-directive categories
4. [x] Update `addImplicit()` — use `preFilterCandidates` for both fact and provisional checks
5. [ ] Test: add a fact when store has > 20 facts — verify coalesce only sees <= 20 candidates (log the count) — verify via Railway logs (`candidateCount` field in `lore_coalesce` events)
6. [ ] Test: add a duplicate fact — verify it is still correctly detected as `skip` after pre-filtering
7. [ ] Test: add a fact that should merge with an existing one — verify merge still occurs after pre-filtering

## Edge Cases & Error Handling
- Index not yet created (fresh deploy): `preFilterCandidates` falls back to `candidates.slice(0, n)` — first n entries by insertion order. Slightly worse quality than similarity-based, but correct and safe.
- Provisionals not yet embedded (just added this session): pre-filtering returns empty or partial results → falls back to first n. The new provisional may not be found for pre-filtering until next query. Acceptable — worst case, we add a duplicate provisional that will be caught on the next reinforcement cycle.
- Embedding call fails: wrap in try/catch, return `candidates.slice(0, n)` as fallback — never block an add operation
- Pre-filter returns 0 results (all candidates are unembedded): fallback to `candidates.slice(0, n)`

## Dependencies
- `implementations/rag/lore-store.js` — only file changed
- Existing lore Vectra index (`data/index-lore`) — no schema change, `{ id }` metadata is sufficient
- No new npm packages

## Status
- Tasks 1–4 complete, deployed 2026-03-20 (commit `8c1a49d`)
- Tasks 5–7 (manual verification) pending — check Railway logs for `candidateCount` field in `lore_coalesce` events

## Companion decision: consolidateLore removed
During this session, `consolidateLore()` was removed entirely. At 800 facts it hit rate limits and the facts were all legitimate — nothing to consolidate. Pre-filtering prevents duplicate accumulation upstream, making consolidation unnecessary. See `sessions/2026-03-20-coalesce-prefilter.md`.

## Open Questions
- None

## Notes
- Pre-filter threshold (20) is conservative. At n=20 the coalesce prompt is ~40 lines — well within gpt-4o-mini's sweet spot for accuracy. Could increase to 30 if false-negative misses become a problem in practice.
- This feature pays off at ~200+ same-category entries. Below that, `preFilterCandidates` short-circuits immediately and costs nothing.
