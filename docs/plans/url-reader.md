# Feature: URL Reader → Lore Ingestion

## Summary
Allow users to give the bot a URL (e.g. a gaming wiki page) and have it extract facts and commit them to its lore/memory system.

## Feature Statement
> This feature allows Discord users to feed the bot a URL so that it can read the page content and extract relevant facts into its memory — enabling it to learn from wikis, articles, and other web content.

## Scope
**In scope:**
- New `!read <url>` command in Discord
- Fetch URL content, extract meaningful text (strip HTML)
- Summarize/chunk content into fact-sized pieces via LLM
- Store extracted facts through the existing lore pipeline (`addImplicit` or `addUserAsserted`)
- Basic feedback to user (what was learned)

**Out of scope:**
- Crawling/following links (single page only)
- Recurring/scheduled URL checks
- PDF, video, or non-HTML content
- Authentication-gated pages

## Acceptance Criteria
- [ ] `!read <url>` fetches the page and extracts facts into lore
- [ ] Bot responds with a summary of what it learned (count + sample facts)
- [ ] Extracted facts go through the existing dedup/coalesce pipeline (no duplicates)
- [ ] Works on typical wiki pages (Fandom, Wikipedia, game wikis)
- [ ] Gracefully handles: unreachable URLs, non-HTML content, empty pages
- [ ] Admin-only access

## Approach

### Text extraction
Use a lightweight HTML-to-text approach. Options:
- **Option A: `node-html-parser` + manual strip** — parse HTML, pull `<p>`, `<li>`, `<h1>`–`<h6>`, `<td>` text. Simple, no headless browser. ~50 lines of code.
- **Option B: `@mozilla/readability`** — Mozilla's Readability algorithm (same as Firefox Reader View). Extracts article content automatically, strips nav/ads/boilerplate. More robust for articles.

**Chosen: Option A for MVP.** Readability is great for articles but wikis have structured content (tables, lists, infoboxes) that Readability sometimes strips. Manual extraction gives us control over what to keep. Can swap in Readability later for article-type URLs.

### Fact extraction
The page text will be too long to store as a single fact. Pipeline:
1. Fetch URL → extract text → chunk into ~2000-char sections (respecting paragraph boundaries)
2. Send each chunk to `gpt-4o-mini` with a prompt like: *"Extract discrete, specific facts from this wiki content. Return as JSON array of fact strings. Focus on factual claims, stats, mechanics, lore — skip navigation, disclaimers, generic filler."*
3. Feed each extracted fact through `addImplicit()` with source `"url-import"` — this gives them the provisional → reinforced → promoted lifecycle, so repeated facts from multiple sources get promoted naturally.

### Storage approach
Use `addUserAsserted` (or equivalent direct insertion) — URL-imported facts are permanent, confidence 1.0. The user deliberately chose to feed the bot this content, so it should be treated as trusted. Each fact gets a `sourceUrl` field for traceability and a source of `"url-import"`.

### Rate limiting / size limits
- Max page size: 500KB of HTML (reject larger)
- Max facts per URL: 50 (truncate extraction after that)
- Cooldown: 1 URL per user per 5 minutes (prevent spam)

## Tasks
1. [x] Add `node-html-parser` dependency to `src/rag/package.json`
2. [x] Create `src/rag/url-reader.js` — fetch URL, extract text, chunk
3. [x] Create extraction prompt + LLM call to turn chunks into facts
4. [x] Wire up `read: <url>` command in `bot.js` — admin check, fetch, extract, store, respond
5. [x] Add source type `"url-import"` + `sourceUrl` field to lore-store entries
6. [ ] Test with real wiki URLs (Fandom, Wikipedia, game-specific wikis)

## Edge Cases & Error Handling
- **URL unreachable / timeout**: Reply "Couldn't reach that URL" — 10s fetch timeout
- **Non-HTML response**: Check Content-Type header, reject non-text/html
- **Huge page**: Enforce 500KB limit, reply "Page too large"
- **No extractable content**: Reply "Couldn't find anything useful on that page"
- **Zero new facts (all duplicates)**: Reply "Already knew all of that"
- **Rate limit hit**: Reply "Slow down, I'm still digesting the last one"

## Dependencies
- `node-html-parser` (npm) — lightweight HTML parser, no native deps
- Existing: `openai` (for extraction LLM call), `lore-store.js` (for storage)

## Open Questions
None — all resolved.
