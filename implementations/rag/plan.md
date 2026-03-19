# Feature 6: RAG / Embeddings

## Goal
Improve persona accuracy by retrieving the most situationally similar Matt messages at query time and injecting them as examples into the prompt.

## Architecture

### Components
| Component | Tool |
|-----------|------|
| Enrichment model | OpenAI `gpt-4o-mini` — generates semantic situation descriptions |
| Embedding model | OpenAI `text-embedding-3-small` |
| Vector store | Vectra (file-based, pure JS, no server) |
| Generation model | OpenAI `gpt-4o-mini` / `gpt-4o` (set via `OPENAI_MODEL` env) |
| Pair index | `data/index-pair/` — embeds semantic situation descriptions |
| Window index | `data/index-window/` — embeds raw conversation windows |

### Data schema (enriched.json)
Each record represents one Matt reply with its full context:
```json
{
  "id": "os_42",
  "inputContext": "Nigel: I think I should quit\nI'm actually serious",
  "response": "Matt: don't do that until you have something lined up lol",
  "embeddingText": "Someone is frustrated with work and seriously considering quitting without another job lined up. A pragmatic, cautious response is called for.",
  "windowText": "Nigel: I think I should quit\nMatt: don't do that until you have something lined up lol\nNigel: yeah fair",
  "responseType": "advice",
  "hasHumor": true,
  "lengthBucket": "short",
  "timestamp": "2024-03-12T10:44:00Z",
  "chat": "os"
}
```

### Pipeline

#### Ingestion (one-time)
1. `npm run enrich` — reads corpus.json, builds context-response pairs, generates embeddingText via LLM, writes enriched.json
2. `npm run index` — reads enriched.json, embeds and writes two Vectra indexes

#### Query flow
```
User message
    → enrich query: LLM rewrites message as semantic situation description
    → embed enriched query with text-embedding-3-small
    → search pair index (top 30) + window index (top 30)
    → merge + deduplicate candidates
    → rerank with heuristics (type match, recency, length alignment)
    → inject top K as context-response examples into system prompt
    → generate with gpt-4o-mini
    → return response
```

### Why two indexes?
- **Pair index** (embeddingText): best for precision — matches on *what situation is happening*
- **Window index** (windowText): best for style — matches on raw conversational texture and pacing

### Why query enrichment?
Raw text similarity is brittle. "I think I should quit my job" doesn't overlap well with "don't do that until you have something lined up". Enriching the query to a situation description bridges that gap.

## Scripts
| Script | What it does |
|--------|-------------|
| `npm run enrich` | Build enriched.json from corpus.json (one-time, ~$0.15) |
| `npm run index` | Build Vectra indexes from enriched.json (one-time, ~$0.003) |
| `npm test` | Interactive CLI for testing |
| `npm test -- --debug` | Same + shows enriched query and retrieved examples |

## Cost Estimates
| Step | Cost |
|------|------|
| Enrichment (gpt-4o-mini, ~10K records) | ~$0.15 one-time |
| Indexing (text-embedding-3-small, ~10K records) | ~$0.003 one-time |
| Per query enrichment (gpt-4o-mini, ~50 tokens) | ~$0.00001 |
| Per query embedding | negligible |
| Per generation (gpt-4o-mini, ~2K in / ~100 out) | ~$0.0003 |

## Status
- [x] Set up package.json
- [x] Write enrichment script (`enrich.js`)
- [x] Write indexing script (`index.js`) — dual index
- [x] Write retrieval helper (`retrieve.js`) — query enrichment + dual search + reranking
- [x] Write generation helper (`generate.js`) — OpenAI, structured example injection
- [x] Write test CLI (`test.js`)
- [ ] Run enrich.js
- [ ] Run index.js
- [ ] Test and tune K
