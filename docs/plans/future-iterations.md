# Future Iterations

Enhancements discussed but explicitly deferred. Roughly priority-ordered within each section.

---

## Cross-Persona Coordination

### Shared memory between bots
Right now each persona has its own isolated memory store. The bots don't know what the others have learned.

**What we'd want:** When Reed learns that Dave had a kid, Matt and Nic should eventually know too — not instantly, but organically (e.g. synced nightly, or propagated when a fact exceeds a confidence threshold).

**Options discussed:**
- Shared Redis key-value store for high-confidence facts (simple, fast)
- Shared volume with a common `memory.json` that all three read (read-only for non-owning personas)
- Periodic export/import job that merges persona memories

**Deferred because:** Fresh start, didn't want added complexity before basic coordination was working.

---

### Smart orchestration beyond message claiming
Right now bots compete randomly and the first to claim wins. Smarter options:

- **Topic routing** — prefer the persona most relevant to the topic (e.g. a gaming question → Nic first)
- **Recency weighting** — the persona who spoke most recently in that channel backs off
- **Turn-taking** — explicit round-robin so each persona gets roughly equal airtime
- **Reaction-based coordination** — losing bots react with emoji instead of responding

**Deferred because:** Random claiming is good enough for now and easier to reason about.

---

## Memory / Learning

### Migrate old Matt memories
Old Railway project has a persistent volume with 300+ seeded Matt memories from the original deployment. Could be worth importing into the new fresh-start Matt if the quality holds up.

**How:** Export from old volume, run through dedup/coalesce, import into new memory store.

**Deferred because:** Fresh start was intentional; old data quality unknown.

---

### Cross-persona memory propagation
High-confidence memories (facts about friends, events) could be propagated from one persona's store to others with a source tag (`source: "cross-persona"`). Lower injection priority than first-hand memories.

---

## Persona Improvements

### Reed and Nic enriched data
Reed and Nic were launched with enriched data built from the shared corpus (filtered by sender). Quality is unknown vs Matt's which has been tuned over many sessions. May need retrieval tuning once they've been running for a while.

### Per-persona retrieval tuning
Matt's retrieval parameters (top-k, rerank thresholds, keyword boost) were tuned empirically. Reed and Nic inherited the same values — they may need their own tuning once there's observability on retrieval quality.

---

## Infrastructure

### Volume wiring verification
New Railway project needs each service's persistent volume confirmed at `/app/data/` — especially that index rebuilds aren't happening on every deploy for the new personas.

### Observability
No dashboard or aggregated log view for the three-service setup. Would be useful to have:
- Per-persona response rate in home channel
- Redis claim win/loss ratio
- Bot cross-talk chain depth distribution
- Memory extraction rate over time
