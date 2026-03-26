# matt-bot

A Discord bot that talks like members of a friend group, built on their real WhatsApp messages.

Supports multiple simultaneous personas — each runs as a separate service with its own voice, corpus, and memory, coordinating over Redis so they respond like actual people in a group chat rather than a bot army.

The bots are aware, involved, and think it's funny.

## How it works

1. **Corpus** — Years of WhatsApp messages are parsed, cleaned, and enriched with semantic situation descriptions per persona
2. **RAG retrieval** — When someone @mentions a bot, the message is enriched via LLM, embedded, and matched against dual vector indexes (situation-based + conversational) to find the most relevant real replies
3. **Memory store** — Each bot maintains a persistent memory of facts, directives, and observations about the friend group. Facts are extracted implicitly from conversations and can be taught explicitly via commands. A 3-strike reinforcement system promotes provisional facts to permanent ones.
4. **Redis coordination** — A shared Redis instance prevents pile-ons: the first bot to atomically claim a message ID wins; others apply a `HOME_PILE_ON_CHANCE` (15%) before also responding
5. **Generation** — Retrieved examples, memories, conversation context, and a detailed persona prompt are assembled and sent to GPT-4o, which generates a response in the persona's voice

## Architecture

```
Discord message (@Bot)
    |
    v
Redis atomic claim (SET NX EX 30)
    ├── won: proceed
    └── lost: 15% chance to also respond
    |
    v
Query enrichment (gpt-4o-mini) ──> Semantic situation description
    |
    v
Dual vector search (Vectra)
    ├── index-pair: situation embeddings
    └── index-window: raw conversation embeddings
    |
    v
Keyword search + humor-aware reranking
    |
    v
Memory retrieval (facts, directives, entity profiles)
    |
    v
System prompt assembly (persona + examples + memories + context)
    |
    v
Generation (gpt-4o) ──> Discord reply
```

```
Implicit memory (parallel):
    Conversation messages
        |
        v
    extractImplicit() ──> coalesce/dedup ──> 3-strike reinforcement ──> memory store
        |
        v
    Passive observation: non-home channels buffer 5 messages → background extraction
```

### Key components

| Component | File | Purpose |
|-----------|------|---------|
| Discord bot | `src/discord-bot/bot.js` | Event handling, command processing, context assembly, passive observation |
| Retrieval | `src/rag/retrieve.js` | Query enrichment, dual-index search, humor-aware reranking |
| Generation | `src/rag/generate.js` | System prompt builder, OpenAI generation, name prefix stripping |
| Memory store | `src/rag/memory-store.js` | Persistent memory — facts, directives, implicit extraction, 3-strike reinforcement, decay |
| Redis client | `src/rag/redis-client.js` | Cross-bot coordination singleton, graceful fallback if REDIS_URL unset |
| Discord log | `src/rag/discord-log.js` | Logs real persona messages from Discord for ongoing learning |
| URL reader | `src/rag/url-reader.js` | Fetch a URL, extract facts, store as background knowledge |
| Encryption | `src/rag/crypto-utils.js` | AES-256-GCM encryption for sensitive content files |
| Persona loader | `src/persona/loader.js` | Reads persona config from `personas/<id>/config.json` |
| Indexing | `src/rag/index.js` | Startup: builds Vectra vector indexes if missing |
| WhatsApp processor | `tools/whatsapp-processor/processor.ts` | One-time: parses WhatsApp exports into structured corpus |
| Enrichment | `tools/enrich.js` | One-time: generates semantic descriptions for all corpus entries |

## Personas

Each persona is a separate Railway service with `PERSONA=<id>` set. Each has its own:

- System prompt (biography, voice, style)
- Enriched corpus filtered to that person's messages
- Memory store, vector indexes
- Voiced memory acknowledgment phrases (in-character responses when the bot notes something new)
- Special behaviors gated behind `specialBehaviors` flags in config

## Setup

### Prerequisites

- Node.js 20+
- OpenAI API key
- Discord bot token(s)
- WhatsApp chat export(s)

### Environment variables

```
DISCORD_TOKEN=your-discord-bot-token
OPENAI_API_KEY=your-openai-api-key
CONTENT_ENCRYPTION_KEY=64-char-hex-string
PERSONA=yourpersona                   # persona ID to load (default: matt)
REDIS_URL=redis://...                 # optional; enables cross-bot coordination
<PERSONA>_DISCORD_USER_ID=...         # optional; enables real message logging for this persona
SPAM_USER_ID=...                      # optional; rate-limits a specific user
```

Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Data pipeline

The corpus and persona data are encrypted at rest. Plaintext source files are never committed or deployed.

```bash
# 1. Parse WhatsApp exports into corpus.json
cd tools/whatsapp-processor && npx ts-node processor.ts

# 2. Enrich corpus and build indexes for a persona (~$0.15 via gpt-4o-mini)
cd tools && node pipeline.js --persona <name> --sender "Full Name"

# 3. Encrypt all sensitive files before deployment
cd tools && npm run encrypt
```

### Adding a new persona

1. Create `personas/<name>/config.json` (see `personas/matt/config.json` for shape)
2. Write `personas/<name>/system-prompt.md` with biography, voice, and style
3. Run `cd tools && node pipeline.js --persona <name> --sender "Full Name"`
4. Run `cd tools && npm run encrypt`
5. Deploy a new Railway service with `PERSONA=<name>`

### Deployment

One Railway service per persona, each auto-deploying from `main`. All share a Redis plugin for coordination.

```bash
# Set env vars per service in Railway dashboard:
#   DISCORD_TOKEN, OPENAI_API_KEY, CONTENT_ENCRYPTION_KEY, PERSONA, REDIS_URL

git push origin main
```

The Docker image stages encrypted data files and builds vector indexes on first boot if not present on the persistent volume.

## Bot commands

| Command | Description |
|---------|-------------|
| `remember: <fact>` | Store a memory (trusted users: permanent; others: provisional) |
| `remember for now: <fact>` | Store a memory with 7-day expiry |
| `forget: <id>` | Remove a stored memory |
| `list memory` | List all stored memories and directives |
| `directive: <rule>` | Add a behavioral rule the bot must follow (admin only) |
| `read: <url>` | Fetch a URL, extract facts, store as background knowledge (admin only) |

## Memory model

Two categories: `memory` and `directive`.

- **memory** — facts the bot knows: personal details, episodic observations, URL-extracted knowledge
  - Permanent by default; `expiresAt` set for time-sensitive things ("for now", "tonight", etc.)
  - Provisional facts require 3 sightings to be promoted to permanent (reinforcement system)
  - Bot-inferred memories not accessed after 180 days are pruned at startup
- **directive** — behavioral rules set by admins; always injected, never pruned

Entity profiles: when a query names a person, all memories tagged with that person are pulled as a consolidated block.

## Privacy

All personal content (corpus, system prompts, memories) is AES-256-GCM encrypted before deployment. Plaintext files exist only locally during development and are gitignored. Git history has been scrubbed of any previously committed plaintext.

## Cost

Minimal. Per-query cost is ~$0.001 (enrichment + embedding + generation). One-time corpus enrichment and indexing runs about $0.15 per persona.

## License

Private project. Not intended for reuse — this is a bespoke bot for one friend group.
