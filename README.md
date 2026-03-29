# matt-bot

A Discord bot that talks like members of a friend group, built on their real WhatsApp messages.

Supports multiple simultaneous personas — each runs as a separate service with its own voice, corpus, and memory, coordinating over Redis so they respond like actual people in a group chat rather than a bot army.

The bots are aware, involved, and think it's funny.

## How it works

1. **Corpus** — Years of WhatsApp messages are parsed, cleaned, and enriched with semantic situation descriptions per persona
2. **RAG retrieval** — When someone @mentions a bot, the message is enriched via LLM, embedded, and matched against dual vector indexes (situation-based + conversational) to find the most relevant real replies
3. **Memory store** — Each bot maintains a persistent Postgres memory of facts, directives, and observations about the friend group. Facts are extracted implicitly from conversations and can be taught explicitly via commands. Entity profiles build LLM summaries of known people for richer context injection.
4. **Redis coordination** — A shared Redis instance manages who responds. Each bot scores the message against its topic affinity (derived from its system prompt at startup), delays proportionally, then races to claim via atomic SET NX. Losing bots react with emoji and may pile on if the topic overlaps their interests.
5. **Generation** — Retrieved examples, memories, entity profiles, conversation context, and a detailed persona prompt are assembled and sent to GPT-4o, which generates a response in the persona's voice

## Architecture

```
Discord message (@Bot)
    |
    v
Topic affinity scoring (keywords from system prompt, cached at startup)
    ├── name mentioned → max score (0ms delay)
    ├── high affinity (≥0.4) → 0ms delay
    ├── medium affinity → 400ms delay
    └── low affinity → 1200ms delay
    |
    v
Recency backoff (bot spoke recently → skip)
    |
    v
Redis atomic claim (SET NX EX 30)
    ├── won: proceed
    └── lost: emoji reaction + pile-on chance (higher if topic overlaps)
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
Memory retrieval (Postgres + pgvector)
    ├── Salience re-ranking: semantic score * 0.7 + access recency * 0.3
    ├── Person boost: memories tagged with a name mentioned in the query
    └── Entity profile: LLM summary for named person injected separately
    |
    v
System prompt assembly (persona + examples + memories + entity profile + context)
    |
    v
Generation (gpt-4o) ──> Discord reply
```

```
Implicit memory (async path):
    Conversation messages (human only — bot messages excluded from extraction)
        |
        v
    extractImplicit() ──> BullMQ queue ──> memory-worker
        |
        v
    memory_staging ──> reconcile() ──> memories table
        |
        v
    Passive observation: non-home channels buffer 5 messages → background extraction

Explicit memory (synchronous):
    remember:/directive:/read: commands ──> Postgres directly
```

### Key components

| Component | File | Purpose |
|-----------|------|---------|
| Discord bot | `src/discord-bot/bot.js` | Event handling, command processing, context assembly, passive observation |
| Retrieval | `src/rag/retrieve.js` | Query enrichment, dual-index search, humor-aware reranking |
| Generation | `src/rag/generate.js` | System prompt builder, OpenAI generation, name prefix stripping |
| Memory store (PG) | `src/rag/memory-store-pg.js` | Postgres reads + explicit writes, entity upsert + summary rebuild |
| Memory store (helpers) | `src/rag/memory-store.js` | extractImplicit, splitOrClassify, coalesce, contradiction check |
| Queue client | `src/rag/queue-client.js` | Publishes inferred-memory + entity-backfill jobs to BullMQ |
| Memory worker | `src/memory-worker/worker.js` | BullMQ consumer — reconciles staged memories, Redlock |
| Worker maintenance | `src/memory-worker/maintenance.js` | Daily pruning, weekly confidence decay, entity summary backfill |
| Redis client | `src/rag/redis-client.js` | Cross-bot coordination singleton, graceful fallback if REDIS_URL unset |
| Topic affinity | `src/rag/topic-affinity.js` | Startup keyword extraction + per-message scoring to inform claim delay |
| Discord log | `src/rag/discord-log.js` | Logs real persona messages from Discord for ongoing learning |
| URL reader | `src/rag/url-reader.js` | Fetch a URL, extract facts, store as background knowledge |
| Encryption | `src/rag/crypto-utils.js` | AES-256-GCM encryption for sensitive content files |
| Persona loader | `src/persona/loader.js` | Reads persona config from `personas/<id>/config.json` |

## Personas

Each persona is a separate Railway service with `PERSONA=<id>` set. Each has its own:

- System prompt (biography, voice, style)
- Enriched corpus filtered to that person's messages
- RAG vector indexes (on Railway volume)
- Postgres memory isolated by `persona_id`
- Voiced memory acknowledgment phrases (in-character responses when the bot notes something new)
- Special behaviors gated behind `specialBehaviors` flags in config

**Currently deployed:** matt, nic, reed, nigel

## Setup

### Prerequisites

- Node.js 20+
- OpenAI API key
- Discord bot token(s)
- WhatsApp chat export(s)
- Postgres with pgvector extension
- Redis

### Environment variables

```
DISCORD_TOKEN=your-discord-bot-token
OPENAI_API_KEY=your-openai-api-key
DATABASE_URL=postgresql://...          # Postgres with pgvector
REDIS_URL=redis://...                  # BullMQ queue + cross-bot coordination
CONTENT_ENCRYPTION_KEY=64-char-hex    # AES-256-GCM key for encrypted data files
PERSONA=yourpersona                    # persona ID to load (default: matt)
<PERSONA>_DISCORD_USER_ID=...         # optional; enables real message logging for this persona
SPAM_USER_ID=...                       # optional; rate-limits a specific user
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
5. Deploy a new Railway service with `PERSONA=<name>` and shared `DATABASE_URL` + `REDIS_URL`

### Deployment

One Railway service per persona + one shared memory-worker service, all auto-deploying from `main`.

```
Bot services:    Dockerfile        (one per persona, PERSONA env var set per service)
Worker service:  Dockerfile.worker (single shared service, persona-agnostic)
Postgres:        Railway managed   (shared, isolated by persona_id column)
Redis:           Railway managed   (BullMQ queue + cross-bot Redis coordination)
Volume:          Mounted on bots   (RAG vector indexes only — memory is in Postgres)
```

```bash
git push origin main
```

On first boot, each bot seeds encrypted data to the persistent volume and builds RAG indexes if missing.

## Bot commands

| Command | Description |
|---------|-------------|
| `remember: <fact>` | Store a memory (trusted users: permanent; others: goes through addLore) |
| `remember for now: <fact>` | Store a memory with 7-day expiry |
| `forget: <id>` | Remove a stored memory |
| `list memory` | List all stored memories and directives |
| `directive: <rule>` | Add a behavioral rule the bot must follow (admin only) |
| `read: <url>` | Fetch a URL, extract facts, store as background knowledge (admin only) |

## Memory model

Two categories: `memory` and `directive`.

- **memory** — facts the bot knows: personal details, episodic observations, URL-extracted knowledge
  - Permanent by default; `expires_at` set for time-sensitive things ("for now", "tonight", etc.)
  - Source weights: explicit=1.0, url-import=0.8, bot-inferred=0.6 (lower weight can't overwrite higher)
  - Confidence decay: 10%/week for bot-inferred memories not accessed in 7+ days
  - Pruning: daily delete of expired + never-accessed stale bot-inferred memories (>30 days)
- **directive** — behavioral rules set by admins; always injected into every prompt, never pruned

**Entity profiles:** the `entities` table holds one LLM-generated summary per known person. When a query names a known person, their summary is injected as a dedicated block in the system prompt. Summaries rebuild incrementally every 3 new tagged memories. Orphaned entity rows (no remaining memories) are cleaned up automatically on memory removal.

**Memory isolation:** each persona only extracts from human messages — other bots' messages are never fed into implicit extraction, preventing cross-persona reinforcement.

## Privacy

All personal content (corpus, system prompts, memories) is AES-256-GCM encrypted before deployment. Plaintext files exist only locally during development and are gitignored. Git history has been scrubbed of any previously committed plaintext.

## Cost

Minimal. Per-query cost is ~$0.001 (enrichment + embedding + generation). One-time corpus enrichment and indexing runs about $0.15 per persona.

## License

Private project. Not intended for reuse — this is a bespoke bot for one friend group.
