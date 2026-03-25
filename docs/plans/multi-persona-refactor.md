# Refactor: Multi-Persona Support

## Motivation

The current bot is structured as a Matt-specific persona, which makes it impossible to run as anyone else. It should be generic enough that any group member's WhatsApp messages can power a persona. The corpus already contains everyone's messages — the architecture is ~70% generic, but the remaining 30% (enrichment pipeline, system prompt, hardcoded names, data layout) locks it to Matt.

## Current State

### What's already generic
- **Lore store** (`lore-store.js`) — zero persona references, works for anyone
- **Startup** (`index.js`, `merge-lore.js`) — fully generic
- **Bot commands** (remember, forget, directive, read URL) — generic
- **Crypto, generation calls, retrieval pipeline structure** — generic

### What's lightly hardcoded (string literals)
- `generate.js` — 4 places say "Matt" in injected prompt text (lines 69, 71, 88, 90)
- `retrieve.js` — line 251 boosts score if text contains "matt"
- `discord-log.js` — function named `logMattMessage`, formats responses as `"Matt: ..."`
- `bot.js` line 588 — bot names itself "Matt" in conversation context
- `bot.js` lines 598-604 — `MATT_DISCORD_USER_ID` env var for logging real Matt's messages

### What's deeply persona-specific
- `system-prompt.md` — entire file is Matt's biography, voice, traits
- `bot.js` — "gweeod" channel hardcoded for always-respond behavior
- `bot.js` — chipple meltdown triggers, injection seeds reference Matt by name
- `enrich.js` — filters to `isMatt` only (line 109), uses `"Matt Guiod"` (line 118), formats as `"Matt: ..."` (line 127)
- `processor.ts` — `MATT_NAME = "Matt Guiod"`, `isMatt` boolean field

### Data pipeline (the hard part)
```
corpus.json (all senders, all messages)
  → enrich.js (filters to isMatt only → context-response pairs)
  → enriched.json (Matt's replies + context, with embeddings)
  → index.js (builds vector indexes from enriched.json)
  → index-pair/ + index-window/ (Matt-only vector indexes)
```

Each persona needs its own enriched data, embeddings, and indexes.

## Target State

### Persona config
A `personas/` directory at the project root, one subdirectory per persona:

```
personas/
  matt/
    config.json          # name, senderNames, special behaviors, env overrides
    system-prompt.md     # persona-specific system prompt (plaintext)
    system-prompt.enc    # encrypted version for deployment
  nigel/
    config.json
    system-prompt.md
    system-prompt.enc
```

**config.json** shape:
```json
{
  "name": "Matt",
  "senderNames": ["Matt Guiod"],
  "nameVariants": ["matt", "matty"],
  "discordUserId": "env:MATT_DISCORD_USER_ID",
  "homeChannel": "gweeod",
  "specialBehaviors": {
    "chipple": true,
    "injection": {
      "enabled": true,
      "seed": "Matt aggressively asks who wants to game"
    }
  }
}
```

### Per-persona data
```
data/
  corpus.json / .enc              # shared — all senders, unchanged
  personas/
    matt/
      enriched.json / .enc        # Matt's context-response pairs
      lore.json / .enc            # Matt's memories
      discord-pairs.json          # real Matt Discord messages
      index-pair/                 # Matt's vector indexes
      index-window/
      index-discord/
    nigel/
      enriched.json / .enc
      lore.json / .enc
      discord-pairs.json
      index-pair/
      index-window/
      index-discord/
```

### Runtime parameterization
- `bot.js` loads persona config at startup (from `PERSONA` env var or channel mapping)
- All pipeline functions accept a persona context object instead of hardcoded names
- `generate.js` interpolates persona name into prompt injection text
- `retrieve.js` boosts persona name variants instead of "matt"
- `discord-log.js` uses persona name for formatting and function names are generic
- Matt-specific behaviors (chipple, injection) only activate when `config.specialBehaviors` enables them

### Tool parameterization
- `enrich.js` accepts `--persona matt` flag, filters by `senderNames`, outputs to persona data dir
- `processor.ts` keeps `isMatt` for backwards compat but corpus stays shared (no structural change needed — enrichment does the filtering)

## Preserved Contracts

These must not change during the refactor:

- [ ] Bot responds to mentions and in the home channel identically to current behavior
- [ ] Memory/lore commands work identically (remember, forget, list memory, directive)
- [ ] Retrieval pipeline produces same quality results for Matt persona
- [ ] Implicit extraction and passive observation work identically
- [ ] Discord message logging for real-person training data works identically
- [ ] Encrypted data files deploy correctly via Dockerfile
- [ ] Startup sequence (seed → merge lore → build indexes) works identically
- [ ] Chipple meltdown triggers work for Matt persona
- [ ] Injection system works for Matt persona
- [ ] Aggression detection works identically
- [ ] Spam detection works identically

## Migration Steps

### Step 1: Introduce persona config loader

Create `src/persona/loader.js` that reads a persona config. Initially load Matt's config from a hardcoded object (no file system change yet). Export a `getPersona()` function that returns the config.

All existing behavior stays identical — this step just introduces the abstraction.

- Verify: bot starts and behaves identically

### Step 2: Parameterize generate.js

Replace the 4 hardcoded "Matt" strings with `persona.name`:
- Line 69: `## What Matt actually said` → `## What ${name} actually said`
- Line 71: `These are real Matt replies` → `These are real ${name} replies`
- Line 88: `## What Matt has said in this Discord recently` → `## What ${name} has said`
- Line 90: `These are real Matt messages` → `These are real ${name} messages`

`buildSystemPrompt` gains a `personaName` parameter.

- Verify: bot output unchanged for Matt (same prompt text as before)

### Step 3: Parameterize retrieve.js

- `loreSearch`: replace hardcoded `"matt"` boost (line 251) with a check against `persona.nameVariants`
- Export functions accept persona config or name variants as parameter

- Verify: same retrieval scores for Matt queries

### Step 4: Parameterize discord-log.js

- Rename `logMattMessage` → `logPersonaMessage(context, response)` (response already includes the name prefix, so the function itself doesn't need the persona name — just the rename)
- Update the one call site in bot.js (line 604) to use `logPersonaMessage` and format as `${persona.name}: ${userMessage}`

- Verify: discord logging still works

### Step 5: Parameterize bot.js identity references

- Line 588: `"Matt"` → `persona.name` (how the bot refers to itself in context)
- Lines 598-604: `MATT_DISCORD_USER_ID` → `persona.discordUserId` (resolved from env)
- Line 238: `INJECTION_SEED` → `persona.specialBehaviors.injection.seed`
- Line 300: `"gweeod"` → `persona.homeChannel`
- Line 369: `"gweeod"` → `persona.homeChannel`

Guard chipple and injection behind `persona.specialBehaviors` flags.

- Verify: all bot behavior identical for Matt config

### Step 6: Restructure data directory

Move existing data files into per-persona layout:
```
data/enriched.json → data/personas/matt/enriched.json
data/enriched.enc  → data/personas/matt/enriched.enc
data/lore.json     → data/personas/matt/lore.json
data/lore.enc      → data/personas/matt/lore.enc
data/discord-pairs.json → data/personas/matt/discord-pairs.json
data/index-pair/   → data/personas/matt/index-pair/
data/index-window/ → data/personas/matt/index-window/
data/index-discord/ → data/personas/matt/index-discord/
```

Keep shared: `data/corpus.json`, `data/corpus.enc`

Update all path references in:
- `retrieve.js` — index paths, enriched path
- `discord-log.js` — pairs path, index path
- `lore-store.js` — lore path
- `index.js` — index build paths
- `merge-lore.js` — lore path
- `Dockerfile` — COPY paths

Paths should be computed from persona config: `data/personas/${persona.id}/`

- Verify: bot starts, indexes load, lore loads, everything works with new paths

### Step 7: Parameterize enrichment pipeline

Update `tools/enrich.js`:
- Accept `--persona <id>` and `--sender <name>` CLI args
- Replace `isMatt` filter with sender name matching
- Replace `"Matt Guiod"` in `nonMattTurns` filter with the sender name
- Replace `"Matt: "` response prefix with `"${senderName}: "`
- Output to `data/personas/<id>/enriched.json`

Update enrichment LLM prompt to say "Do NOT mention the speaker by name" (already mostly generic).

- Verify: running `node enrich.js --persona matt --sender "Matt Guiod"` produces identical output to current enriched.json

### Step 8: Persona config files on disk

Move the hardcoded Matt config from Step 1 into `personas/matt/config.json`. Update `loader.js` to read from disk based on `PERSONA` env var.

Create a skeleton `personas/README.md` documenting how to add a new persona.

- Verify: bot starts with `PERSONA=matt` and works identically

### Step 9: Separate system prompts per persona

Move `src/persona/system-prompt.md` → `personas/matt/system-prompt.md`
Move `src/persona/system-prompt.enc` → `personas/matt/system-prompt.enc`

Update `bot.js` to load system prompt path from persona config.
Update encryption script to handle per-persona prompt files.

- Verify: bot loads Matt's system prompt and responds identically

### Step 10: Clean up

- Remove old `src/persona/system-prompt.enc` (moved to personas/)
- Remove `isMatt` references from comments in source code
- Update `CLAUDE.md` to document multi-persona structure
- Update `Dockerfile` to copy `personas/` directory
- Update `tools/encrypt.js` to encrypt per-persona files
- Remove any shims or compatibility code from earlier steps

- Verify: full end-to-end test with Matt persona

## Rollback Plan

Each step is independently revertable via `git revert`. No step involves data migration that can't be undone — the data files are moved (git tracks this), and path references are updated in code.

The riskiest step is **Step 6** (data directory restructure) because it touches paths across many files simultaneously. If it breaks, revert the commit and all paths go back to flat layout.

## Out of Scope

- Writing a second persona's system prompt (that's a feature, not part of the refactor)
- Running the enrichment pipeline for a second persona
- Channel-based persona routing (multiple personas active in one deployment) — this can be added after the refactor as a feature on top of the persona config system
- Changing the WhatsApp processor's `isMatt` field — the corpus structure stays as-is; enrichment handles persona filtering
- Splitting the bot into multiple deployments
- Any behavioral changes to the Matt persona

## Open Questions

None — all blocking questions were resolved in the requirements discussion.

## Completed

2026-03-24 — All 10 steps implemented. The bot is now fully parameterized:
- Persona config loaded from `personas/<id>/config.json` via `PERSONA` env var
- All runtime code reads identity, paths, and behaviors from persona config
- Data directory restructured to `data/personas/<id>/` with shared corpus at `data/`
- Enrichment and pipeline tools accept `--persona` and `--sender` flags
- Encryption handles per-persona files
- CLAUDE.md and Dockerfile updated for new structure
- Matt persona preserved identically — no behavioral changes

Old flat data files (`data/enriched.*`, `data/lore.*`, `data/index-*`) can be removed once the per-persona versions are verified working in production.
