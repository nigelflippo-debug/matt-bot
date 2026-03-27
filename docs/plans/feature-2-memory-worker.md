# Feature: Memory Worker Skeleton

## Summary

This feature creates a standalone memory-worker service that consumes inferred-memory jobs from a Redis queue so that bot instances can offload async memory writes without blocking response generation.

## Scope

**In scope:**
- `src/memory-worker/` — worker entry point and package.json
- BullMQ Worker consuming the `memory-inferred` queue
- Per-job: parse facts, insert rows into `memory_staging`, trigger reconciliation stub (log only)
- `src/rag/queue-client.js` — BullMQ Queue publisher (not yet called from bot; wired in Feature #5)
- `Dockerfile.worker` at project root for the Railway worker service
- Graceful shutdown on SIGTERM
- Error resilience: Redis/DB transient failures don't crash the worker

**Out of scope:**
- Actual reconciliation logic (Feature #6)
- Redlock (Feature #7)
- Bot-side publishing to the queue (Feature #5)
- Coalesce / contradiction LLM calls (Feature #6)

## Acceptance Criteria

- [ ] Worker starts without crashing when `REDIS_URL` and `DATABASE_URL` are set
- [ ] Worker processes jobs from the `memory-inferred` BullMQ queue
- [ ] Each job's facts are inserted as individual rows in `memory_staging`
- [ ] Reconciliation stub fires (logs `reconciliation_triggered` with `persona_id`) after each batch of inserts
- [ ] Worker stays running through Redis disconnects (BullMQ handles reconnect)
- [ ] Worker shuts down cleanly on SIGTERM (drains in-progress job, then exits)
- [ ] `Dockerfile.worker` builds and starts the worker process
- [ ] `src/rag/queue-client.js` exports `publishInferredMemory(personaId, facts, conversationId)` — no-op if `REDIS_URL` not set (same pattern as `redis-client.js`)

## Approach

**Queue library: BullMQ** over raw BLPOP. BullMQ builds on ioredis and provides built-in retry and dead-letter support — both needed in Feature #12. Choosing it now avoids rewriting the queue layer later. BullMQ uses a standard key namespace (`bull:memory-inferred:*`) so both publisher (`queue-client.js`) and consumer (`worker.js`) must use BullMQ.

**Job contract:**
```js
// Published by bots (Feature #5), consumed by worker
{
  persona_id: string,
  facts: [{ text: string, person: string | null }],
  conversation_id: string,
  added_at: string  // ISO timestamp
}
```

Each fact in `facts[]` becomes one `memory_staging` row. `conversation_id` is stored for future audit use but not used in this feature.

**Worker structure:**
- `src/memory-worker/worker.js` — BullMQ Worker, one concurrent job at a time per persona (can increase later)
- `src/memory-worker/package.json` — deps: bullmq, pg, dotenv, ioredis (peer dep for bullmq)
- `src/rag/queue-client.js` — BullMQ Queue publisher; exported and used by bots in Feature #5
- `Dockerfile.worker` — installs rag deps (shared modules) + worker deps; CMD: `node src/memory-worker/worker.js`

**No separate DB client package.json** — worker imports `../db/client.js` (Feature #1); pg is a dep in `src/memory-worker/package.json`.

## Tasks

1. [x] Add `bullmq` to `src/rag/package.json`
2. [x] Create `src/rag/queue-client.js` — exports `publishInferredMemory(personaId, facts, conversationId)`; no-op if `REDIS_URL` unset
3. [x] Create `src/memory-worker/package.json` — deps: bullmq, ioredis, dotenv (pg resolved via rag shared module)
4. [x] Create `src/memory-worker/worker.js` — BullMQ Worker on `memory-inferred` queue; inserts staging rows; logs reconciliation trigger; SIGTERM handler
5. [x] Create `Dockerfile.worker` — installs rag + worker deps; copies src; CMD: `node src/memory-worker/worker.js`

## Edge Cases & Error Handling

- `REDIS_URL` not set: `queue-client.js` returns early (no-op); worker logs a warning and exits rather than crashing silently
- `DATABASE_URL` not set: worker logs error on startup and exits (DB is required for the worker to do anything useful)
- DB insert fails for one fact: log the error, continue processing remaining facts in the job — don't fail the whole job
- Job payload malformed (missing `persona_id`, non-array `facts`): log and mark job as failed (BullMQ moves to failed queue)
- Redis disconnect mid-job: BullMQ re-queues the job (at-least-once delivery); staging inserts are idempotent enough at this stage (duplicates resolved by reconciliation in Feature #6)
- Worker crashes mid-job: BullMQ lock expiry causes re-queue after lock TTL; acceptable at this scale

## Dependencies

- Feature #1 (Postgres schema) — `memory_staging` table must exist before worker runs
- `bullmq` npm package (^5.x)
- `ioredis` npm package (existing in `src/rag/`)
- `pg` npm package (added in Feature #1)
- `REDIS_URL` env var (existing Railway service)
- `DATABASE_URL` env var (new Railway Postgres)

## Open Questions

_(none — all resolved in the architecture planning phase)_
