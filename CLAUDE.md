# matt-bot

Discord bot that responds as a configurable persona, using RAG retrieval over real WhatsApp messages + a persistent lore/memory system. Currently deployed as Matt Guiod; supports multiple personas via the `PERSONA` env var.

## Project Structure

```
matt-bot/
├── src/                     # Runtime code (what the Dockerfile deploys)
│   ├── discord-bot/
│   │   └── bot.js           # Entry point — event handling, commands, context assembly
│   ├── rag/
│   │   ├── retrieve.js      # Query enrichment, dual-index vector search, keyword search, reranking
│   │   ├── generate.js      # System prompt builder + OpenAI generation
│   │   ├── lore-store.js    # Persistent memory — memory/directive model, salience scoring, entity profiles
│   │   ├── url-reader.js    # Fetch a URL, extract text, chunk + extract facts via gpt-4o-mini
│   │   ├── discord-log.js   # Logs real persona messages from Discord for ongoing learning
│   │   ├── crypto-utils.js  # AES-256-GCM encryption/decryption
│   │   ├── index.js         # Startup: build Vectra vector indexes (if missing)
│   │   └── merge-lore.js    # Startup: seed lore from image into persistent volume
│   └── persona/
│       └── loader.js        # Persona config loader — reads from personas/<id>/config.json
├── personas/                # Persona definitions (one directory per persona)
│   └── matt/
│       ├── config.json      # Name, sender names, special behaviors, env var mappings
│       ├── system-prompt.enc  # Encrypted persona prompt
│       └── system-prompt.md   # Plaintext persona prompt (gitignored)
├── tools/                   # One-time scripts and dev utilities (not deployed)
│   ├── encrypt.js           # Encrypt plaintext files before deployment
│   ├── enrich.js            # Generate semantic descriptions for corpus (one-time, per-persona)
│   ├── pipeline.js          # Combined enrich + index (one-time, per-persona)
│   ├── test-rag.js          # Interactive test CLI (RAG pipeline)
│   ├── test-simple.js       # Interactive test CLI (simple pipeline)
│   └── whatsapp-processor/  # Parse WhatsApp exports into corpus (one-time)
├── data/                    # Encrypted .enc files only (plaintext gitignored)
│   ├── corpus.enc           # Shared corpus (all senders)
│   └── personas/
│       └── matt/
│           ├── enriched.enc   # Persona-specific enriched data
│           ├── lore.enc       # Persona-specific memories
│           ├── index-pair/    # Vector indexes (gitignored)
│           ├── index-window/
│           └── index-lore/
├── docs/
│   ├── plans/               # Feature design documents
│   ├── sops/                # Standard Operating Procedures (for Claude)
│   └── PROJECT.md           # Original project spec and architecture decisions
├── sessions/                # Session resumption files (gitignored, local only)
├── Dockerfile
└── railway.toml
```

## How It Runs

```
@Bot message in Discord
  → bot.js loads persona config (PERSONA env var, default: matt)
  → bot.js fetches recent channel messages for context
  → retrieve.js: enrich query (gpt-4o-mini) → embed → dual vector search → keyword search → rerank
  → lore-store.js: retrieve memories + directives; entity profile if query names a person
    salience = semantic_similarity * 0.7 + access_recency * 0.3
  → discord-log.js: retrieve recent real persona messages from this server
  → generate.js: assemble system prompt (persona + examples + memories + context) → generate (gpt-4o)
  → bot.js posts reply

Implicit memory:
  → bot.js extracts facts from conversation via lore-store.js extractImplicit()
  → Dedup check via coalesce() → writes directly to memory (no staging pipeline)
  → Bot posts a conversational acknowledgment in home channel when it notes something new
  → Passive observation: bot extracts from non-home channels every 5 messages
```

## Multi-Persona Architecture

The bot supports multiple personas via a config-driven system:

- **Persona selection**: Set `PERSONA=matt` env var (default). Each persona has its own config, system prompt, enriched data, lore, and vector indexes.
- **Shared corpus**: `data/corpus.json` contains all senders' messages. The enrichment pipeline filters to persona-specific messages.
- **Per-persona data**: `data/personas/<id>/` holds enriched data, lore, discord pairs, and vector indexes.
- **Persona config**: `personas/<id>/config.json` defines name, sender names, name variants, home channel, Discord user ID env var, and special behaviors.
- **Special behaviors**: Persona-specific features (chipple meltdown, auto-injection) are gated behind `specialBehaviors` flags in config — only active for personas that define them.

### Adding a new persona

1. Create `personas/<name>/config.json` (see `personas/matt/config.json` for shape)
2. Write `personas/<name>/system-prompt.md` with the persona's biography, voice, and style
3. Run `cd tools && node enrich.js --persona <name> --sender "Full Name"` to build enriched data
4. Run `cd tools && npm run encrypt -- --persona <name>` to encrypt
5. Deploy with `PERSONA=<name>`

## Memory Model

Two categories: `memory` and `directive`.

- **memory** — everything the bot knows: personal facts, episodic details, URL-extracted knowledge
  - Permanent by default; `expiresAt` set for time-sensitive things ("for now", "tonight", etc.)
  - `source: "url-import"` memories are injected as background context ("inform your take, don't recite it")
  - `lastAccessedAt` tracked — salience blends semantic score + access recency
  - Bot-inferred memories never accessed after 180 days are pruned at startup
- **directive** — behavioral rules set by admins; always injected, never pruned

Entity profiles: when a query names a person (Reed, Dave, etc.), all memories tagged with that person are pulled as a consolidated block and injected separately from general memory retrieval.

## Key Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `OPENAI_API_KEY` | Yes | OpenAI API (embeddings + generation) |
| `CONTENT_ENCRYPTION_KEY` | Yes (prod) | 64-char hex key for AES-256-GCM decryption |
| `PERSONA` | No | Persona ID to load (default: `matt`) |
| `OPENAI_MODEL` | No | Override generation model (default: `gpt-4o`) |
| `MATT_DISCORD_USER_ID` | No | Discord user ID for real Matt message logging |
| `SPAM_USER_ID` | No | Discord user ID for spam rate limiting |

## Encryption

All sensitive content is encrypted at rest. **Never commit plaintext data files.**

- `data/corpus.enc` — shared encrypted corpus
- `data/personas/<id>/enriched.enc`, `data/personas/<id>/lore.enc` — per-persona encrypted data
- `personas/<id>/system-prompt.enc` — encrypted persona prompt
- Plaintext equivalents are gitignored and exist only locally
- `loadEncryptedJson()` / `loadEncryptedText()` in `crypto-utils.js` handle decryption with fallback to plaintext for local dev (no key needed locally)
- Run `cd tools && npm run encrypt` after any changes to plaintext source files

## Deployment

- Hosted on Railway, auto-deploys from `main` branch
- Dockerfile copies `src/`, `personas/`, and encrypted data into image
- Startup: seeds enc files to persistent volume → merges lore → builds indexes if missing → starts bot
- Persistent volume at `/app/data/` holds vector indexes, lore.json, discord-pairs.json

## Development

```bash
# Install tools dependencies (first time)
cd tools && npm install

# Test locally (needs .env with OPENAI_API_KEY, plaintext data files in data/)
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
- Sensitive content is always encrypted before commit — never commit plaintext corpus, lore, or system prompt
- Feature plans go in `docs/plans/`
- System prompts live at `personas/<id>/system-prompt.enc` — edit the plaintext locally, then run `cd tools && npm run encrypt`
