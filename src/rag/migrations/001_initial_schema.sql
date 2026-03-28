-- Central memory schema — all DDL uses IF NOT EXISTS for idempotency.
-- Run via: node src/rag/db-migrate.js

CREATE EXTENSION IF NOT EXISTS vector;

-- entities: named persons the bot knows about, partitioned by persona
CREATE TABLE IF NOT EXISTS entities (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id  TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  aliases     JSONB       NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entities_persona_name ON entities (persona_id, name);

-- memories: source of truth for all persona memory
CREATE TABLE IF NOT EXISTS memories (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id       TEXT        NOT NULL,
  category         TEXT        NOT NULL CHECK (category IN ('memory', 'directive')),
  text             TEXT        NOT NULL,
  embedding        vector(1536),
  entity_id        UUID        REFERENCES entities(id) ON DELETE SET NULL,
  confidence       FLOAT       NOT NULL DEFAULT 1.0,
  source           TEXT        NOT NULL,
  source_weight    FLOAT       NOT NULL DEFAULT 1.0,
  expires_at       TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS memories_persona_category ON memories (persona_id, category);
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw   ON memories USING hnsw (embedding vector_cosine_ops);

-- memory_staging: inferred memories awaiting reconciliation by the worker
CREATE TABLE IF NOT EXISTS memory_staging (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    TEXT        NOT NULL,
  text          TEXT        NOT NULL,
  person_name   TEXT,
  source        TEXT        NOT NULL DEFAULT 'bot-inferred',
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ
);

-- Partial index — worker queries only for unreconciled rows
CREATE INDEX IF NOT EXISTS memory_staging_pending
  ON memory_staging (persona_id, added_at)
  WHERE reconciled_at IS NULL;

-- memory_versions: audit history of changes to memories rows
CREATE TABLE IF NOT EXISTS memory_versions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  text        TEXT        NOT NULL,
  confidence  FLOAT       NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS memory_versions_memory_id ON memory_versions (memory_id);
