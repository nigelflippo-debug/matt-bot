# matt-bot

Discord bot that responds as Matt Guiod, using RAG retrieval over his real WhatsApp messages + a persistent lore/memory system.

## Project Structure

```
matt-bot/
├── src/
│   ├── discord-bot/     # Bot runtime — event handling, commands, context assembly
│   │   └── bot.js       # Main entry point
│   ├── rag/             # Core pipeline
│   │   ├── retrieve.js  # Query enrichment, dual-index vector search, keyword search, reranking
│   │   ├── generate.js  # System prompt builder + OpenAI generation
│   │   ├── lore-store.js    # Persistent memory — facts, directives, implicit extraction, decay
│   │   ├── discord-log.js   # Logs real Matt messages from Discord for ongoing learning
│   │   ├── crypto-utils.js  # AES-256-GCM encryption/decryption
│   │   ├── encrypt.js       # CLI: encrypt plaintext files before deployment
│   │   ├── enrich.js        # One-time: generate semantic descriptions for corpus
│   │   ├── index.js         # One-time: build Vectra vector indexes
│   │   ├── merge-lore.js    # Startup: seed lore from image into persistent volume
│   │   └── pipeline.js      # One-time: full enrich + index pipeline
│   ├── simple/          # Test harness + encrypted system prompt
│   └── whatsapp-processor/  # One-time corpus parser (TypeScript)
├── data/                # Encrypted .enc files only (plaintext gitignored)
├── docs/
│   ├── plans/           # Feature design documents
│   ├── sops/            # Standard Operating Procedures (for Claude)
│   └── PROJECT.md       # Original project spec and architecture decisions
├── sessions/            # Session resumption files (gitignored, local only)
├── Dockerfile
└── railway.toml
```

## How It Runs

```
@MattBot message in Discord
  → bot.js fetches recent channel messages for context
  → retrieve.js: enrich query (gpt-4o-mini) → embed → dual vector search → keyword search → rerank
  → lore-store.js: retrieve relevant facts, directives, soft observations
  → discord-log.js: retrieve recent real Matt messages from this server
  → generate.js: assemble system prompt (persona + examples + lore + context) → generate (gpt-4o)
  → bot.js posts reply

Implicit memory:
  → bot.js extracts facts from conversation via lore-store.js extractImplicit()
  → New facts start as "provisional" (confidence 0.3, 90-day TTL)
  → Second sighting → reinforced (confidence 0.6, TTL refreshed)
  → Third sighting → promoted to permanent fact (confidence 1.0)
  → Passive observation: bot extracts from non-gweeod channels every 5 messages
```

## Key Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `OPENAI_API_KEY` | Yes | OpenAI API (embeddings + generation) |
| `CONTENT_ENCRYPTION_KEY` | Yes (prod) | 64-char hex key for AES-256-GCM decryption |
| `OPENAI_MODEL` | No | Override generation model (default: `gpt-4o`) |

## Encryption

All sensitive content is encrypted at rest. **Never commit plaintext data files.**

- `data/corpus.enc`, `data/enriched.enc`, `data/lore.enc` — encrypted JSON data
- `src/simple/system-prompt.enc` — encrypted persona prompt
- Plaintext equivalents are gitignored and exist only locally
- `loadEncryptedJson()` / `loadEncryptedText()` in `crypto-utils.js` handle decryption with fallback to plaintext for local dev (no key needed locally)
- Run `cd src/rag && npm run encrypt` after any changes to plaintext source files

## Deployment

- Hosted on Railway, auto-deploys from `main` branch
- Dockerfile copies `src/` and `data/*.enc` into image
- Startup: seeds enc files to persistent volume → merges lore → builds indexes if missing → starts bot
- Persistent volume at `/app/data/` holds vector indexes, lore.json, discord-pairs.json

## Development

```bash
# Test locally (needs .env with OPENAI_API_KEY, plaintext data files in data/)
cd src/rag && node test.js          # RAG pipeline test CLI
cd src/simple && node test.js       # Simple pipeline test CLI
cd src/rag && node test.js --debug  # Shows enriched query + retrieved examples
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `!remember <fact>` | Store a fact about someone |
| `!forget <id>` | Remove a stored fact |
| `!lore` | List all stored facts and directives |
| `!directive <rule>` | Add a behavioral rule the bot must follow |

## Sessions

Session files live locally at `sessions/YYYY-MM-DD-<slug>.md` (gitignored). They capture enough context to resume work across conversations. Read the most recent relevant session file at the start of a new session.

## Patch Notes

At the end of a working session (or at a natural checkpoint), write patch notes to `docs/patch-notes-YYYY-MM-DD.md`. These are user-facing changelogs — written for the friend group, not for developers. They should cover what changed and why, grouped by area (memory, retrieval, persona, infrastructure, etc.). See existing patch notes in `docs/` for the format.

## Conventions

- Sensitive content is always encrypted before commit — never commit plaintext corpus, lore, or system prompt
- Source code goes in `src/` with a subdirectory per component
- Feature plans go in `docs/plans/`
- The system prompt lives encrypted at `src/simple/system-prompt.enc` — edit the plaintext locally, then run encrypt
