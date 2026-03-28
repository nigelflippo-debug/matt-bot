# Patch Notes — 2026-03-27

## Central Memory Sync — Full Migration to Postgres

The bot's memory system has been completely rebuilt around a shared Postgres database. All personas now read and write to the same central store instead of isolated JSON files on each service's volume.

### What changed

**Memory now lives in Postgres**
- All memories, directives, and entity profiles are stored in a shared Postgres database with pgvector for similarity search
- Every persona has its own row-level namespace (`persona_id`) — no cross-contamination
- Memory retrieval uses the same salience scoring as before (semantic similarity × 0.7 + access recency × 0.3)

**Inferred memory is now async**
- When the bot picks up an implicit fact from conversation, it no longer writes directly to a local file
- Facts are queued via BullMQ (Redis) to a dedicated memory-worker service
- The worker reconciles each fact against existing memories: duplicates are discarded, overlapping facts are merged, contradictions are resolved, new facts are promoted
- Bot-inferred facts (confidence 0.6) can never overwrite explicitly set memories (confidence 1.0)

**Dedicated memory-worker service**
- Runs separately from the bot, consumes the inferred-memory queue
- Uses Redlock (distributed Redis lock) so concurrent workers can't race on the same persona
- Scheduled daily pruning: removes expired memories and stale inferences never accessed after 30 days
- Scheduled weekly confidence decay: bot-inferred memories lose 10% confidence per week if not accessed

**Historical memories migrated**
- All existing memories from each persona's Railway volume were migrated into Postgres
- Matt: 39 entries, Nic: 36 entries, Reed: 52 entries

### What didn't change

- RAG retrieval (corpus search, vector indexes) is unchanged — volumes still hold the indexes
- Explicit memory commands (`remember:`, `forget:`, `directive:`, `list memory`) work the same
- URL reading and fact extraction work the same
- Persona configs, system prompts, and enriched data are unchanged
