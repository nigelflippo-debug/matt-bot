# Project: Matt Bot

## Problem Statement
A private friend group wants a Discord bot that sounds and responds like their friend Matt, for entertainment. Matt is aware and involved.

## System Statement
Matt Bot is a Discord bot that responds in the voice and style of Matt Guiod, informed by years of his real WhatsApp messages. It responds when mentioned in a Discord channel, using recent conversation context to generate replies that feel natural and characteristically Matt.

## Goals & Success Criteria
- [ ] Bot responds in Discord when mentioned
- [ ] Responses feel like Matt to the friend group (Matt himself is the primary judge)
- [ ] Persona is informed by real message data, not just manual description
- [ ] Cheap to run — fits within free or near-free hosting and API tiers for casual use

## Out of Scope
- WhatsApp integration (Meta API restrictions make this impractical)
- Unprompted / proactive responses (future state)
- Voice responses
- Vector search / RAG (Phase 2 if Option B persona is insufficient)
- Any public or wide release — this is a private bot for one group

## Architecture

### Components
| Component | Responsibility |
|-----------|---------------|
| Discord Bot | Listens for mentions, retrieves channel context, posts responses |
| Persona Layer | System prompt encoding Matt's voice, vocabulary, humor, and example messages |
| Claude API | Generates responses given persona + context + user message |
| Message Processor | Parses WhatsApp export, isolates Matt's messages, produces clean reference data for persona construction |
| Hosting | Long-running process on Railway or Fly.io (local for dev/testing) |

### Data Flow
```
User mentions @MattBot in Discord
        ↓
Discord Bot receives mention event
        ↓
Constructs prompt:
  - Persona system prompt (Matt's voice + example messages)
  - Recent channel messages (N to be determined during implementation)
  - User's message
        ↓
Claude API generates response
        ↓
Discord Bot posts response to channel
```

### Architecture Decisions
| Decision | Chosen | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| Platform | Discord | WhatsApp | WhatsApp API is business-only/expensive; unofficial libs violate ToS and get banned |
| Persona approach | Option C: RAG | A: prompt-only, B: static examples | Static examples too generic; RAG grounds responses in Matt's actual messages |
| Embedding model | OpenAI text-embedding-3-small | Voyage, local models | Cheap, fast, widely supported |
| Generation LLM | OpenAI gpt-4o-mini / gpt-4o | Claude API | Switched from Claude — OpenAI needed for embeddings, simpler to use one SDK |
| Vector store | Vectra | Chroma, Pinecone, pgvector | File-based, no server, pure JS, zero infrastructure |
| Hosting | Railway or Fly.io | Self-hosted long-term | Cheap, simple, suitable for a low-traffic private bot |

### Cross-Cutting Concerns
| Concern | Approach |
|---------|----------|
| API keys | Environment variables, never hardcoded |
| Rate limits | Rely on Discord and Claude API defaults for MVP; revisit if needed |
| Error handling | Graceful fallback response if Claude API fails |
| Cost | Monitor Claude API usage; low traffic group so should stay minimal |

## Features
| # | Feature | Priority | Depends On |
|---|---------|----------|------------|
| 1 | WhatsApp message processor | Must-have | Nothing |
| 2 | Persona system prompt | Must-have | 1 |
| 3 | Discord bot (mention + respond) | Must-have | 2 |
| 4 | Channel context window | Must-have | 3 |
| 5 | Hosting & deployment | Must-have | 3 |
| 6 | RAG / embeddings upgrade | Must-have | 1, 2 |

## Build Order
1. **Message processor** — parse export, isolate Matt's messages, output clean corpus
2. **Persona system prompt** — build from corpus + conscious style input from Nigel & Matt
3. **Discord bot** — mention detection, Claude API integration, response posting
4. **Context window** — inject last N channel messages into prompt
5. **Deploy** — ship to Railway or Fly.io

### Walking Skeleton
Features 1–3: a bot that can be mentioned and responds as Matt. Proves the full pipeline works before polishing.

## Risks & Open Questions
| Item | Type | Notes |
|------|------|-------|
| Persona accuracy | Risk | Output quality depends heavily on prompt craft — Matt's feedback is the validation mechanism |
| Context window size | Open question | N messages to include — decide during implementation |
| RAG upgrade complexity | Risk | If Option B is insufficient, Option C (embeddings) adds significant complexity |

## Research Findings
- WhatsApp export format: `[MM/DD/YY, HH:MM:SS AM/PM] Name: message` — clean and parseable
- Matt's display name in export: `Matt Guiod`
- System messages, media omissions, and edited message tags are all easily filtered
- Data spans several years — sufficient corpus for persona construction
- Discord bot API: well-documented, proper bot support, free tier sufficient for private group

## Upgrade Path (Phase 2)
If Option B persona is not accurate enough:
- Embed all of Matt's messages using an embeddings model
- At query time, retrieve the most semantically relevant messages
- Inject retrieved messages as additional context (RAG / Option C)

## Future Data Sources (Phase 3+)
The WhatsApp export is a one-time bootstrap. Future phases may add new sources of truth:
- **Discord history** — once the bot is live, Matt's real messages in the server become ongoing training data
- **Additional WhatsApp exports** — periodic re-exports to refresh the corpus
- **Other sources** — TBD based on where the group communicates

The message processor should be designed to accept new sources without requiring a full rebuild.
