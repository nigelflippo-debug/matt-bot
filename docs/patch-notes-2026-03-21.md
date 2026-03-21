# Patch Notes — 2026-03-21

## Memory System

- **3-strike promotion** — Implicitly extracted facts now follow a lifecycle: provisional (first sighting, confidence 0.3) → reinforced (second sighting, confidence 0.6, TTL refreshed) → promoted to permanent fact (third sighting, confidence 1.0). Prevents one-off mentions from becoming permanent memory.
- **Passive observation** — The bot now extracts facts from channels it's not mentioned in. Buffers 5 messages, then runs implicit extraction. Learns without being asked.
- **Non-admin `!remember` stores as provisional** — User-submitted facts start at confidence 0.3 instead of being instantly permanent. Still need to prove out through reinforcement.
- **Auto-TTL for temporal references** — Facts containing time-bound language ("this weekend", "next month") automatically get a 30-day expiry so stale plans don't linger forever.
- **Person tagging + contradiction detection** — Lore entries are now tagged with the person they're about. New facts are checked against existing ones for contradictions before storing.
- **Broader extraction window** — Extraction prompt widened to capture soft plans, reactions, and preferences — not just hard facts.
- **Provisional decay extended** — TTL stretched from 30 to 90 days, decay slope softened to match. Provisional facts get more time to be reinforced.
- **Recent extractions cache** — 10-minute in-memory cache of recently extracted facts injected into retrieval, so the bot can reference something it just learned.
- **Stopped storing bot-directed messages** — Messages like "hey matt what do you think" are no longer extracted as facts about the sender.

## RAG Pipeline

- **Contextual examples** — Retrieved examples now include what Matt was replying to (with `>` prefix), not just his response. Model can judge whether an example fits the current situation.
- **Discord examples with context** — Same treatment for recent real Matt messages from the server.
- **Humor-aware reranking** — New `detectHumor()` function. Joking queries boost candidates with humor, penalize dry ones. Type match and recency heuristics also strengthened.
- **Removed wasted embedding call** — Raw message was embedded in parallel with enrichment but never used. One fewer API call per query.
- **Token ceiling raised** — `max_tokens` from 150 to 300. Most responses stay short, but fired-up rants can now go long.

## Persona Fidelity

- **Switched to gpt-4o** — Default model upgraded from gpt-4o-mini for better persona adherence.
- **Frequency penalty 0.3** — Discourages repetitive LLM-default phrasing ("That's definitely something...").
- **Hardened Final Instruction** — Explicit anti-LLM-tell examples, hard length constraint ("one sentence is usually enough"), context prioritization (Discord examples > RAG examples > lore).
- **Facts moved to recency position** — "Things you know" block moved from early in the prompt to just before Final Instruction for maximum model attention. Reframed as active recall ("you remember these") instead of passive reference.

## Security & Repo Cleanup

- **All sensitive data encrypted** — corpus, enriched data, lore, and system prompt now AES-256-GCM encrypted at rest. Plaintext files are gitignored and never deployed.
- **Git history scrubbed** — All previously committed plaintext data, session files, persona plans, and mining scripts removed from every historical commit.
- **Hardcoded Discord ID moved to env var** — `SPAM_USER_ID` no longer in source code.
- **Private content removed** — Mining scripts (contained real anecdotes and political opinions), persona plan (contained family/bio details), lore extraction artifacts all removed from tracking.

## Repo Reorganization

- **`implementations/` → `src/`** — Standard convention, cleaner.
- **Plans separated from code** — All `plan.md` files moved to `docs/plans/`. No more guessing what's a design doc vs runtime code.
- **SOPs moved to `docs/sops/`** — Out of the repo root.
- **Dead code removed** — Stale `persona/` directory (old Anthropic SDK test) deleted.
- **README added** — Architecture diagram, setup instructions, bot commands, privacy notes.
- **CLAUDE.md rewritten** — Full file map, runtime data flow, encryption workflow, deployment details.
- **Contributor KMS plan** — Documented SOPS + age migration path for when external contributors need access. Deferred until needed.
