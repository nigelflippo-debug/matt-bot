# Matt Bot

A Discord bot that talks like our friend Matt, built on his real WhatsApp messages.

Matt is aware, involved, and thinks it's funny.

## How it works

1. **Corpus** — Years of Matt's WhatsApp messages are parsed, cleaned, and enriched with semantic situation descriptions
2. **RAG retrieval** — When someone @mentions the bot, the message is enriched via LLM, embedded, and matched against dual vector indexes (situation-based + conversational) to find the most relevant real Matt replies
3. **Lore store** — The bot maintains a persistent memory of facts, directives, and observations about the friend group. It extracts new facts from conversations implicitly and can be taught explicitly via commands
4. **Generation** — Retrieved examples, lore facts, conversation context, and a detailed persona prompt are assembled and sent to GPT-4o, which generates a response in Matt's voice

## Architecture

```
Discord message (@MattBot)
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
Lore retrieval (facts, directives, soft observations)
    |
    v
System prompt assembly (persona + examples + lore + context)
    |
    v
Generation (gpt-4o) ──> Discord reply
```

### Key components

| Component | File | Purpose |
|-----------|------|---------|
| Discord bot | `src/discord-bot/bot.js` | Event handling, command processing, context assembly |
| Retrieval | `src/rag/retrieve.js` | Query enrichment, dual-index search, keyword search, reranking |
| Generation | `src/rag/generate.js` | System prompt builder, OpenAI generation |
| Lore store | `src/rag/lore-store.js` | Persistent memory — facts, directives, implicit extraction, decay |
| Discord log | `src/rag/discord-log.js` | Logs real Matt messages from Discord for ongoing learning |
| Encryption | `src/rag/crypto-utils.js` | AES-256-GCM encryption for sensitive content files |
| WhatsApp processor | `tools/whatsapp-processor/processor.ts` | One-time: parses WhatsApp exports into structured corpus |
| Enrichment | `tools/enrich.js` | One-time: generates semantic descriptions for all corpus entries |
| Indexing | `src/rag/index.js` | Startup: builds Vectra vector indexes if missing |

## Setup

### Prerequisites

- Node.js 20+
- OpenAI API key
- Discord bot token
- WhatsApp chat export(s)

### Environment variables

```
DISCORD_TOKEN=your-discord-bot-token
OPENAI_API_KEY=your-openai-api-key
CONTENT_ENCRYPTION_KEY=64-char-hex-string
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

# 2. Enrich corpus and build indexes (~$0.15 via gpt-4o-mini)
cd tools && npm run pipeline

# 3. Encrypt all sensitive files before deployment
cd tools && npm run encrypt
```

### Deployment

Deploys to Railway via Dockerfile. Auto-deploys on push to `main`.

```bash
# Set env vars in Railway dashboard:
#   DISCORD_TOKEN, OPENAI_API_KEY, CONTENT_ENCRYPTION_KEY

git push origin main
```

The Docker image stages encrypted data files and builds vector indexes on first boot if not present on the persistent volume.

## Bot commands

| Command | Description |
|---------|-------------|
| `!remember <fact>` | Store a fact about someone |
| `!forget <id>` | Remove a stored fact |
| `!lore` | List all stored facts and directives |
| `!directive <rule>` | Add a behavioral rule the bot must follow |

## Privacy

All personal content (corpus, system prompt, lore) is AES-256-GCM encrypted before deployment. Plaintext files exist only locally during development and are gitignored. Git history has been scrubbed of any previously committed plaintext.

## Cost

Minimal. Per-query cost is ~$0.001 (enrichment + embedding + generation). The one-time corpus enrichment and indexing runs about $0.15 total.

## License

Private project. Not intended for reuse — this is a bespoke bot for one friend group.
