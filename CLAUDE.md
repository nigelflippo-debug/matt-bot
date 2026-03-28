# matt-bot

Discord bot that responds as a configurable persona, using RAG retrieval over real WhatsApp messages + a persistent Postgres-backed memory system. Currently deployed as Matt Guiod, Nic, Reed, and Nigel; supports multiple personas via the `PERSONA` env var.

## Project Structure

```
matt-bot/
├── src/                     # Runtime code (what the Dockerfile deploys)
│   ├── discord-bot/
│   │   └── bot.js           # Entry point — event handling, commands, context assembly
│   ├── rag/
│   │   ├── retrieve.js      # Query enrichment, dual-index vector search, keyword search, reranking
│   │   ├── generate.js      # System prompt builder + OpenAI generation
│   │   ├── memory-store-pg.js  # All memory reads + explicit writes (Postgres + pgvector); entity upsert + summary rebuild
│   │   ├── memory-store.js  # extractImplicit, detectTemporalExpiry, splitOrClassify, coalesce — NOT safe to import from worker
│   │   ├── queue-client.js  # Publishes inferred-memory + entity-backfill jobs to BullMQ
│   │   ├── db-client.js     # Shared pg Pool (must live in src/rag/ for module resolution)
│   │   ├── reconcile.js     # Worker reconciliation pass — fully self-contained (no persona loader dep)
│   │   ├── url-reader.js    # Fetch a URL, extract text, chunk + extract facts via gpt-4o-mini
│   │   ├── discord-log.js   # Logs real persona messages from Discord for ongoing learning
│   │   ├── crypto-utils.js  # AES-256-GCM encryption/decryption
│   │   └── index.js         # Startup: build Vectra vector indexes (if missing)
│   ├── memory-worker/
│   │   ├── worker.js        # BullMQ consumer (memory-inferred + entity-maintenance queues), Redlock
│   │   └── maintenance.js   # runPruning() daily, runDecay() weekly, rebuildStaleEntities() on-demand
│   └── persona/
│       └── loader.js        # Persona config loader — reads from personas/<id>/config.json
├── personas/                # Persona definitions (one directory per persona)
│   └── <id>/
│       ├── config.json      # Name, sender names, special behaviors, env var mappings
│       ├── system-prompt.enc  # Encrypted persona prompt
│       └── system-prompt.md   # Plaintext persona prompt (gitignored)
├── tools/                   # One-time scripts and dev utilities (not deployed)
│   ├── encrypt.js           # Encrypt plaintext files before deployment
│   ├── enrich.js            # Generate semantic descriptions for corpus (one-time, per-persona)
│   ├── pipeline.js          # Combined enrich + index (one-time, per-persona)
│   ├── migrate-memory.js    # One-time: migrate lore.json into Postgres memories table
│   ├── test-rag.js          # Interactive test CLI (RAG pipeline)
│   ├── test-simple.js       # Interactive test CLI (simple pipeline)
│   └── whatsapp-processor/  # Parse WhatsApp exports into corpus (one-time)
├── data/                    # Encrypted .enc files only (plaintext gitignored)
│   ├── corpus.enc           # Shared corpus (all senders)
│   └── personas/
│       └── <id>/
│           ├── enriched.enc   # Persona-specific enriched data
│           ├── index-pair/    # RAG vector indexes (on Railway volume)
│           └── index-window/
├── docs/
│   ├── plans/               # Feature design documents
│   ├── sops/                # Standard Operating Procedures (for Claude)
│   └── PROJECT.md           # Original project spec and architecture decisions
├── sessions/                # Session resumption files (gitignored, local only)
├── Dockerfile               # Bot service image
├── Dockerfile.worker        # Memory worker service image
└── railway.toml
```

## How It Runs

```
@Bot message in Discord
  → bot.js loads persona config (PERSONA env var, default: matt)
  → bot.js fetches recent channel messages for context
  → retrieve.js: enrich query (gpt-4o-mini) → embed → dual vector search → keyword search → rerank
  → memory-store-pg.js: pgvector similarity search → salience re-ranking → entity profile if query names a person
    salience = semantic_similarity * 0.7 + access_recency * 0.3
  → discord-log.js: retrieve recent real persona messages from this server
  → generate.js: assemble system prompt (persona + examples + memories + entity profile + context) → generate (gpt-4o)
  → bot.js posts reply

Implicit memory (two-step async path):
  → bot.js extracts facts from conversation via memory-store.js extractImplicit()
  → queue-client.js publishes job to BullMQ memory-inferred queue
  → memory-worker/worker.js consumes job → writes to memory_staging → reconcile() → promotes to memories
  → Bot posts a conversational acknowledgment in home channel when it notes something new
  → Passive observation: bot extracts from non-home channels every 5 messages

Explicit memory (synchronous path):
  → remember:/directive:/read: commands → memory-store-pg.js → Postgres directly
  → Inline coalesce + contradiction check before insert

Worker maintenance (memory-worker):
  → Daily: runPruning() — delete expired + never-accessed stale bot-inferred memories (>30 days)
  → Weekly: runDecay() — decay confidence 10%/week on bot-inferred memories not accessed in 7+ days
  → On startup: rebuildStaleEntities() — build LLM summaries for any entities without one
```

## Multi-Persona Architecture

The bot supports multiple personas via a config-driven system:

- **Persona selection**: Set `PERSONA=matt` env var (default). Each persona has its own config, system prompt, enriched data, and RAG indexes.
- **Shared corpus**: `data/corpus.enc` contains all senders' messages. The enrichment pipeline filters to persona-specific messages.
- **Per-persona data**: `data/personas/<id>/` holds enriched data and RAG vector indexes.
- **Postgres isolation**: All memory tables (`memories`, `memory_staging`, `memory_versions`, `entities`) have a `persona_id` column — each persona's data is fully isolated.
- **Persona config**: `personas/<id>/config.json` defines name, sender names, name variants, home channel, Discord user ID env var, and special behaviors.
- **Special behaviors**: Persona-specific features (chipple meltdown, auto-injection) are gated behind `specialBehaviors` flags in config — only active for personas that define them.

**Currently deployed personas:** matt, nic, reed, nigel

### Adding a new persona

1. Create `personas/<name>/config.json` (see `personas/matt/config.json` for shape)
2. Write `personas/<name>/system-prompt.md` with the persona's biography, voice, and style
3. Run `cd tools && node enrich.js --persona <name> --sender "Full Name"` to build enriched data
4. Run `cd tools && npm run encrypt -- --persona <name>` to encrypt
5. Deploy a new Railway service with `PERSONA=<name>` and shared `DATABASE_URL` + `REDIS_URL`

## Memory Model

Two categories: `memory` and `directive`.

- **memory** — everything the bot knows: personal facts, episodic details, URL-extracted knowledge
  - Permanent by default; `expires_at` set for time-sensitive things ("for now", "tonight", etc.)
  - `source: "url-import"` memories are injected as background context ("inform your take, don't recite it")
  - `last_accessed_at` tracked — salience blends semantic score + access recency
  - Source weights: explicit=1.0, url-import=0.8, bot-inferred=0.6 (lower weight can't overwrite higher)
  - Confidence decay: 10%/week for bot-inferred memories not accessed in 7+ days
  - Pruning: daily delete of expired + stale (bot-inferred, never accessed, >30 days)
- **directive** — behavioral rules set by admins; always injected into every prompt, never pruned

**Write paths:**
- Explicit (`remember:`, `directive:`, `read:`) → `memory-store-pg.js` → Postgres directly, synchronous
- Inferred (`extractImplicit`) → `queue-client.js` → BullMQ → worker → `memory_staging` → `reconcile()` → `memories`

**Entity profiles:** the `entities` table holds one row per `(persona_id, person_name)` with an LLM-generated summary. When a query names a known person, their summary is injected as a consolidated block in the system prompt. Summaries are rebuilt incrementally every 3 new tagged memories, and in bulk on worker startup via `rebuildStaleEntities()`.

## Key Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `OPENAI_API_KEY` | Yes | OpenAI API (embeddings + generation) |
| `DATABASE_URL` | Yes | Postgres connection string (Railway managed) |
| `REDIS_URL` | Yes | Redis connection string for BullMQ queue + Redlock |
| `CONTENT_ENCRYPTION_KEY` | Yes (prod) | 64-char hex key for AES-256-GCM decryption |
| `PERSONA` | No | Persona ID to load (default: `matt`) |
| `OPENAI_MODEL` | No | Override generation model (default: `gpt-4o`) |
| `MATT_DISCORD_USER_ID` | No | Discord user ID for real Matt message logging |
| `SPAM_USER_ID` | No | Discord user ID for spam rate limiting |

## Encryption

All sensitive content is encrypted at rest. **Never commit plaintext data files.**

- `data/corpus.enc` — shared encrypted corpus
- `data/personas/<id>/enriched.enc` — per-persona enriched data
- `personas/<id>/system-prompt.enc` — encrypted persona prompt
- Plaintext equivalents are gitignored and exist only locally
- `loadEncryptedJson()` / `loadEncryptedText()` in `crypto-utils.js` handle decryption with fallback to plaintext for local dev (no key needed locally)
- Run `cd tools && npm run encrypt` after any changes to plaintext source files

## Deployment

- **Bot services**: Railway, one per persona, auto-deploy from `main` branch via Dockerfile
- **Memory worker**: Railway, single shared service, Dockerfile.worker — no personas/ dir, no volume
- **Postgres**: Railway managed, shared across all personas via `persona_id` column
- **Redis**: Railway managed, used for BullMQ queue + Redlock
- **Volume**: mounted on bot services only, holds RAG vector indexes (`index-pair/`, `index-window/`) — memory is now in Postgres, not on volume

On bot startup:
- Seeds encrypted corpus/enriched data to persistent volume
- Builds RAG indexes if missing
- Enqueues `rebuild-entities` job for entity summary backfill
- Starts Discord client

## Development

```bash
# Install tools dependencies (first time)
cd tools && npm install

# Test locally (needs .env with OPENAI_API_KEY + DATABASE_URL, plaintext data files in data/)
cd tools && node test-rag.js          # RAG pipeline test CLI
cd tools && node test-simple.js       # Simple pipeline test CLI
cd tools && node test-rag.js --debug  # Shows enriched query + retrieved examples

# Encrypt before deploying
cd tools && npm run encrypt

# Rebuild corpus for a persona (one-time)
cd tools && node pipeline.js --persona matt --sender "Matt Guiod"
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `remember: <fact>` | Store a memory (trusted users: permanent; others: goes through addLore) |
| `remember for now: <fact>` | Store a memory with 7-day expiry |
| `forget: <id>` | Remove a stored memory |
| `list memory` | List all stored memories and directives |
| `directive: <rule>` | Add a behavioral rule the bot must follow (admin only) |
| `read: <url>` | Fetch a URL, extract facts, store as background knowledge (admin only) |

## Sessions

Session files live locally at `sessions/YYYY-MM-DD-<slug>.md` (gitignored). They capture enough context to resume work across conversations. Read the most recent relevant session file at the start of a new session.

## Patch Notes

At the end of a working session (or at a natural checkpoint), write patch notes to `docs/patch-notes-YYYY-MM-DD.md`. These are user-facing changelogs — written for the friend group, not for developers. They should cover what changed and why, grouped by area (memory, retrieval, persona, infrastructure, etc.). See existing patch notes in `docs/` for the format.

## Conventions

- `src/` is runtime-only code — what the Dockerfile deploys. No scripts, no tests, no one-time tools.
- `personas/` holds per-persona configs and system prompts — deployed alongside `src/`
- `tools/` is everything else — encryption, enrichment, testing, corpus processing
- Sensitive content is always encrypted before commit — never commit plaintext corpus, enriched data, or system prompt
- Feature plans go in `docs/plans/`
- System prompts live at `personas/<id>/system-prompt.enc` — edit the plaintext locally, then run `cd tools && npm run encrypt`
- `src/persona/loader.js` calls `getPersona()` at module load time — **never import from the memory worker** (no personas/ dir in worker image)
- `reconcile.js` is intentionally self-contained: inlines all helpers to avoid importing from memory-store.js (which has a persona loader dep)
