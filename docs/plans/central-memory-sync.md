# Project: Central Memory Sync

## Problem Statement

Bot instances maintain independent local memory stores on Railway persistent volumes. When multiple personas are running simultaneously, they disagree about facts discussed in the chat — each instance only knows what it has observed. Redeployments also risk memory loss if the volume isn't preserved correctly.

## System Statement

A centralized Postgres database (with pgvector) stores all persona memory, replacing per-instance local volumes. A shared worker service consumes a Redis queue to handle inferred memory writes, reconciliation, and scheduled maintenance — offloading bulk write-path intelligence from bot instances. Bots read memory directly from Postgres. Explicit user commands (`remember:`, `directive:`) write synchronously to Postgres; bot-inferred memories and URL imports go through a staging + async reconciliation pipeline. All personas share the infrastructure layer, partitioned by `persona_id`.

## Goals & Success Criteria

- [ ] Bot instances never disagree about facts discussed in chat
- [ ] Memory persists across redeploys with no volume dependency
- [ ] Write latency is not felt by users (async pipeline for inferred memories; synchronous for explicit commands)
- [ ] Duplicate and contradictory memories are resolved automatically in the background
- [ ] Adding a new persona requires no changes to worker or DB infrastructure

## Out of Scope

- Migrating corpus/enriched (WhatsApp) indexes to central DB — these are static and read-only
- Cross-persona memory sharing — each persona has isolated memory within the shared DB
- Real-time memory sync — async reconciliation is sufficient
- Multi-tenant access control between personas

---

## Architecture

### Components

| Component | Responsibility |
|---|---|
| **Central DB** (Postgres + pgvector) | Source of truth for all persona memory. Tables: `memories`, `memory_staging`, `memory_versions`, `entities`. Partitioned by `persona_id`. |
| **Worker Service** | Shared Railway service. Consumes Redis queue. Runs inferred write pipeline (staging → reconciliation → promotion). Runs scheduled jobs (pruning, confidence decay). |
| **Bot Instances** | One Railway service per persona (`PERSONA=matt`, `PERSONA=nigel`). Read memory directly from Postgres. Explicit commands write synchronously to Postgres. Inferred memories + URL imports published to Redis queue. `extractImplicit()` runs in the bot (it already has conversation context). |
| **Redis** | Existing Railway service. Adds: job queue (inferred write jobs from bots to worker) + Redlock (distributed locks on reconciliation pass). |

### Deployment Topology

```
Railway project
├── matt-bot          (existing — PERSONA=matt)
├── nigel-bot         (existing — PERSONA=nigel)
├── memory-worker     (new — shared across all personas)
├── Postgres          (new — Railway-managed, pgvector extension)
└── Redis             (existing — Railway-managed)
```

### Data Flow

**Write path — explicit commands** (`remember:`, `directive:`):
```
User: @Bot remember: Matt loves hiking
  → bot writes directly to memories table (synchronous)
  → bot generates embedding inline, stores in pgvector
  → bot responds with confirmation (added/merged/skipped)
```

**Write path — inferred memories** (`extractImplicit`, `read:`):
```
Bot observes conversation
  → extractImplicit() runs in bot (LLM extracts facts from conversation context)
  → publish extracted facts to Redis queue (no local write, no further LLM wait)

Worker picks up job
  → insert into memory_staging (fast, no LLM)
  → triggers reconciliation for that persona

Worker reconciliation pass (event-driven on new staging entries + scheduled safety net)
  → acquire Redlock (persona_id)
  → for each staged entry:
      → vector similarity pre-filter against memories
      → if similarity > 0.95: mark duplicate, discard
      → if similarity 0.7–0.95: run coalesce LLM → merge or skip
      → if similarity < 0.7: run contradiction check → add or replace
  → promote to memories; write history to memory_versions
  → release lock
```

**Write path — forget:**
```
User: @Bot forget: old hiking fact
  → bot deletes directly from memories table (synchronous)
  → bot responds with confirmation
```

**Read path:**
```
Bot receives message
  → query Postgres directly (pgvector similarity search for memories)
  → simple SELECT for directives (category = 'directive', no vector search)
  → entity profile lookup via entities table (if person named in query)
  → also query memory_staging for recent unreconciled entries (bridges gap)
  → inject memories + directives into system prompt
```

### Architecture Decisions

| Decision | Chosen | Alternatives | Rationale |
|---|---|---|---|
| Central store | Postgres + pgvector | Mongo, Pinecone | pgvector consolidates memory + vectors; Railway-native; no extra service |
| Memory isolation | Per-persona rows (`persona_id`) | Separate DBs per persona | Shared infra, clean separation, no operational overhead |
| Sync model | Direct DB reads | Local cache + sync | Eliminates drift entirely; Postgres read latency negligible vs OpenAI calls |
| Explicit write path | Synchronous to `memories` | Through staging like inferred | User is waiting for feedback (added/merged/skipped); low volume; UX requires it |
| Inferred write path | Async via Redis queue → staging table | Synchronous DB write | Bot never blocked by LLM; staging is durable (Postgres, not just Redis) |
| Extraction location | `extractImplicit()` stays in bot | Move to worker | Bot already has conversation context; shipping context over Redis adds complexity for no gain |
| Reconciliation trigger | Event-driven (on new staging entries) + scheduled safety net | Scheduled only | Minimizes gap between extraction and retrievability; scheduled pass catches anything missed |
| Conflict prevention | Redlock on reconciliation pass | DB unique constraint | Prevents concurrent workers racing on same persona's staging entries |
| Coalesce timing | Background reconciliation pass | Synchronous at write time | Write-path LLM calls add user-visible latency; background is the enterprise pattern |
| Vector similarity pre-filter | Hard thresholds (< 0.7 distinct, > 0.95 duplicate) | LLM for all pairs | Cuts LLM cost significantly; only invoke for ambiguous middle band |
| Entity model | `entities` table with FK from day one | `person` string field, migrate later | Avoids a data migration; entity resolution built into schema from the start |
| Memory versioning | `memory_versions` history table | Overwrite in place | Auditability; can reconstruct what changed and why |
| Vector migration scope | Memory index only → pgvector | Migrate all indexes | Corpus/enriched are static; only memory index causes drift |
| Worker deployment | Single shared service | One worker per persona | Worker is persona-agnostic; jobs tagged with `persona_id`; no duplication needed |
| Bot deployment | Separate Railway services per persona | Single multi-persona bot | Fault isolation; independent deploys; existing pattern |

### Cross-Cutting Concerns

| Concern | Approach |
|---|---|
| Auth | `DATABASE_URL` env var shared by worker and bots; Redlock uses existing Redis connection |
| Error handling | Failed reconciliation jobs → dead-letter Redis key; worker logs + retries once |
| Pruning | Worker runs `pruneExpired` + `pruneStale` as scheduled jobs; removed from bot startup |
| Confidence decay | Weekly worker pass scales confidence on unaccessed bot-inferred memories |
| Local volume | Retained for corpus/enriched indexes only; memory volume mount removed from bot |
| Volume data migration | Pre-cutover: extract `memory.json` from each persona's Railway volume, seed into Postgres via migration script. SSH access to volumes TBD — may require migration endpoint on bot. |
| Source reliability | `source_weight` numeric field (explicit = 1.0, bot-inferred = 0.6); used in contradiction resolution |
| Staging gap | Read path queries `memory_staging` as fallback for recent unreconciled entries; eliminates the old `recentExtractions` in-memory cache |

---

## Features

| # | Feature | Priority | Depends On |
|---|---|---|---|
| 1 | Postgres schema: `memories`, `memory_staging`, `memory_versions`, `entities` tables + pgvector, `persona_id` partitioning. Entity table included from day one. | must-have | — |
| 2 | Worker service skeleton (Railway service, Redis queue consumer, event-driven reconciliation trigger) | must-have | — |
| 3 | Migrate memory reads: bot queries Postgres directly (pgvector similarity for memories, simple SELECT for directives, entity profile via entities table, staging fallback for recent entries) | must-have | 1 |
| 4 | Explicit write path: `remember:` / `directive:` / `forget:` write synchronously to Postgres with inline embedding | must-have | 1 |
| 5 | Inferred write path: `extractImplicit()` stays in bot → publishes to Redis queue → worker inserts into `memory_staging`. Entity resolution via `entities` table on write. | must-have | 1, 2 |
| 6 | Worker reconciliation pass: vector similarity pre-filter (< 0.7 skip, > 0.95 dedup, middle band → coalesce LLM) + contradiction detection → promote/merge from staging to `memories`; write history to `memory_versions` | must-have | 5 |
| 7 | Redlock on reconciliation pass to prevent concurrent workers racing on same persona | must-have | 6 |
| 8 | Remove memory volume dependency from bot | must-have | 3, 4, 5 |
| 9 | Source reliability weighting: `source_weight` numeric field; used in conflict resolution | should-have | 6 |
| 10 | Confidence decay: weekly worker pass scales confidence on unaccessed bot-inferred memories | should-have | 2, 1 |
| 11 | Worker handles pruning (expired + stale) as scheduled jobs | should-have | 2, 1 |
| 12 | Dead-letter queue + single retry for failed reconciliation jobs | should-have | 2 |
| 13 | Old volume data migration script | must-have | 1 |

## Build Order

1. **#1, #2** (parallel) — schema + worker skeleton; nothing else can start without these
2. **#3** — bots read from Postgres (validate reads work end-to-end before touching writes)
3. **#4, #5** (parallel) — both write paths: explicit (synchronous) and inferred (async queue)
4. **#6** — reconciliation pass (core intelligence moves to worker; includes pre-filter)
5. **#7** — Redlock (harden reconciliation against concurrent races)
6. **#8** — remove volume dependency (only safe once all read + write paths validated)
7. **#9, #10, #11, #12** (parallel) — operational hardening
8. **#13** — old volume migration (deferred; coordinate with Railway volume access)

---

## Risks & Open Questions

| Item | Type | Notes |
|---|---|---|
| Railway volume SSH access | Unknown | Need to verify we can extract `memory.json` from existing volumes before cutover. May need a `/export-memory` endpoint on the bot as fallback. |
| Worker scaling | Risk | Single worker is a bottleneck at high write volume. Acceptable for current scale; revisit if reconciliation queue backs up. |
| Reconciliation latency | Mitigated | Event-driven reconciliation on new staging entries minimizes gap. Staging fallback in read path bridges any remaining window. Scheduled pass as safety net. |
| pgvector index performance | Unknown | Need to validate query latency at current memory scale. Likely fine; revisit if retrieval slows. |
| Explicit write coalesce | Design | Synchronous `remember:` still needs inline coalesce/contradiction check to give user feedback. This is acceptable — explicit commands are low-volume and user-initiated. |

## Research Findings

All blocking unknowns from Phase 2 were resolved:

- **Memory isolation**: per-persona rows with `persona_id` — personas isolated, infrastructure shared
- **DB choice**: Postgres + pgvector — consolidates relational store and vector index, Railway-native
- **Sync model**: direct DB reads — eliminates drift, latency cost negligible
- **Lock/dedup strategy**: Redlock on reconciliation pass — Redis already present, handles concurrent worker races cleanly
- **Vector index migration scope**: memory index only → pgvector; corpus/enriched indexes stay local (static, read-only)
- **Extraction location**: `extractImplicit()` stays in bot — already has conversation context, no benefit to moving
- **Write path split**: explicit commands (synchronous, user-facing) vs inferred (async, worker-managed) — different latency requirements demand different paths
- **Entity table timing**: included in initial schema to avoid post-hoc migration
