# Feature: Remove Volume Dependency

## Summary

This feature removes all local file/Vectra memory calls from the bot now that reads and writes go through Postgres. The memory Railway volume is no longer required for memory.

## Scope

**In scope:**
- Remove `pruneExpired`, `pruneStale`, `attributePersons`, `deduplicateMemory`, `embedPendingMemory` from bot.js imports and all call sites
- Remove `merge-memory.js` from Dockerfile startup CMD
- Update the `ready` log line to drop pruned counts

**Out of scope:**
- Deleting `memory-store.js` — still exports `extractImplicit`, `detectTemporalExpiry`, `coalesce`, `checkContradiction`, `splitOrClassify` used by the bot and worker
- Removing the volume mount itself from Railway — corpus/enriched indexes still live there
- Pruning and stale cleanup — moved to worker scheduled jobs (Features #10, #11)

## Acceptance Criteria

- [ ] Bot starts with no calls to local-file memory functions
- [ ] `embedPendingMemory` removed from all 3 call sites (passive, url-read, main response path)
- [ ] `pruneExpired`, `pruneStale`, `attributePersons`, `deduplicateMemory` removed from startup
- [ ] `merge-memory.js` no longer runs at startup
- [ ] `ready` log still fires cleanly

## Tasks

1. [x] Update bot.js imports from `memory-store.js` — keep only `extractImplicit`, `detectTemporalExpiry`
2. [x] Remove startup calls in `client.once(ClientReady)` and update ready log
3. [x] Remove 3 `embedPendingMemory().catch(() => {})` call sites
4. [x] Remove `node /app/src/rag/merge-memory.js` from Dockerfile CMD

## Dependencies

- Features #3, #4, #5 complete — all memory I/O goes through Postgres

## Open Questions

_(none)_
