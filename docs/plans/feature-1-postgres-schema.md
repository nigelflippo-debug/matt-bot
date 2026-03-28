# Feature: Postgres Schema

## Summary

This feature creates the central Postgres + pgvector database schema so that all bot instances and the worker can store and query persona memory from a single source of truth.

## Scope

**In scope:**
- pgvector extension on Railway Postgres
- Four tables: `memories`, `memory_staging`, `memory_versions`, `entities`
- `persona_id` text column on all tables (row-level isolation)
- HNSW index on `memories.embedding` for vector similarity search
- `src/db/client.js` — shared pg Pool, imported by bots and worker
- `src/db/migrate.js` — standalone migration runner
- `src/db/migrations/001_initial_schema.sql` — idempotent SQL

**Out of scope:**
- Any application code reading or writing these tables (Features #3, #4, #5)
- Data migration from existing Railway volumes (Feature #13)
- Worker service (Feature #2)

## Acceptance Criteria

- [ ] Migration is idempotent — safe to run twice with no error or data change
- [ ] All four tables exist with correct columns after running `node src/db/migrate.js`
- [ ] pgvector extension enabled (`CREATE EXTENSION IF NOT EXISTS vector`)
- [ ] HNSW index exists on `memories.embedding`
- [ ] `src/db/client.js` exports a pg Pool that connects via `DATABASE_URL`
- [ ] `pg` added to `src/rag/package.json` (runtime shared module location)

## Approach

Single SQL migration file run by a minimal Node.js runner. All DDL uses `IF NOT EXISTS` for idempotency — no versioning table needed at this scale. IDs are UUIDs via `gen_random_uuid()` (built into Postgres 13+). Vector dimension is 1536 (`text-embedding-3-small`). HNSW index chosen over IVFFlat: better recall at ~1000-memory scale with no training requirement.

The DB client (`src/db/client.js`) is a shared module under `src/` — importable by the bot (future Features #3, #4, #5) and the worker (Feature #2). No separate package.json; `pg` is added to `src/rag/package.json` since all shared runtime code lives there.

## Schema

**`entities`** — named persons the bot knows about
```
id           uuid pk default gen_random_uuid()
persona_id   text not null
name         text not null
aliases      jsonb default '[]'
created_at   timestamptz default now()
```
Index: `(persona_id, name)`

**`memories`** — source of truth for all persona memory
```
id               uuid pk default gen_random_uuid()
persona_id       text not null
category         text not null check (category in ('memory', 'directive'))
text             text not null
embedding        vector(1536)
entity_id        uuid references entities(id) on delete set null
confidence       float not null default 1.0
source           text not null   -- 'explicit' | 'bot-inferred' | 'url-import'
source_weight    float not null default 1.0
expires_at       timestamptz
last_accessed_at timestamptz
added_at         timestamptz default now()
updated_at       timestamptz
```
Indexes: `(persona_id, category)`, HNSW on `embedding`

**`memory_staging`** — inferred memories awaiting reconciliation
```
id              uuid pk default gen_random_uuid()
persona_id      text not null
text            text not null
person_name     text                -- raw name string before entity resolution
source          text not null default 'bot-inferred'
added_at        timestamptz default now()
reconciled_at   timestamptz         -- null = pending
```
Index: `(persona_id, reconciled_at)` where `reconciled_at is null`

**`memory_versions`** — audit history of memory changes
```
id          uuid pk default gen_random_uuid()
memory_id   uuid not null references memories(id) on delete cascade
text        text not null
confidence  float not null
changed_at  timestamptz default now()
reason      text
```
Index: `(memory_id)`

## Tasks

1. [x] Add `pg` to `src/rag/package.json`
2. [x] Create `src/rag/db-client.js` — pg Pool using `DATABASE_URL`; graceful error if not set
3. [x] Create `src/rag/migrations/001_initial_schema.sql` — all DDL, all `IF NOT EXISTS`, pgvector extension, HNSW index
4. [x] Create `src/rag/db-migrate.js` — reads and runs migration files in order; logs result; safe to re-run

Note: files placed in `src/rag/` rather than `src/db/` — Node module resolution requires `pg` to be in the same package tree as `db-client.js`.

## Edge Cases & Error Handling

- `DATABASE_URL` not set: `client.js` throws a clear error on first use (not at import time, so local dev without a DB still works until a DB call is made)
- Migration already run: all `IF NOT EXISTS` → no-op, exits cleanly
- pgvector extension not available: `CREATE EXTENSION IF NOT EXISTS vector` will error with a clear Postgres message; this is a deploy-time concern, not a runtime concern

## Dependencies

- Railway Postgres service with pgvector (Railway's Postgres image includes pgvector by default)
- `pg` npm package (^8.x)
- `DATABASE_URL` env var on all services that run the migration or use the DB

## Open Questions

_(none — all resolved in the architecture planning phase)_
