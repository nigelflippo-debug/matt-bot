# Patch Notes — 2026-03-22

## Memory System (Major Overhaul)

- **Simplified categories** — Everything is now "memory" or "directive". The old fact/episodic/provisional distinction is gone. If it's something the bot knows, it's memory. If it's a behavioral rule, it's a directive.
- **Removed 3-stage pipeline** — Provisional → reinforced → promoted is gone. Implicit extraction now writes straight to memory on first sighting, with a dedup check to avoid noise. Simpler and faster.
- **Temporal expiry is the only distinction** — "remember for now:" stores with a 7-day expiry. Everything else is permanent. No more category juggling.
- **Access-based salience** — Memory retrieval now blends semantic similarity (70%) with how recently a memory was accessed (30%). Facts that keep coming up surface higher. Facts that haven't been touched in a while drift down.
- **Stale pruning** — Bot-inferred memories that have never been used get pruned at startup after 30 days. Explicit and URL-imported memories are never pruned.
- **Entity profiles** — When a query names one of the guys (Reed, Dave, etc.), the bot now pulls all memories about that person as a consolidated block instead of scattering them across generic top-K results. Responses about specific people should feel more grounded.
- **Bot no longer learns from itself** — Its own replies were being passed to implicit extraction labeled as "Matt" and treated as real statements. Fixed — only human messages go through extraction.
- **Staleness window shortened** — Both the stale pruning threshold and the access recency decay window dropped from 180 days to 30. The bot operates on friend-group timescales, not enterprise ones.

## Commands

- **Natural `remember:` responses** — No more "Got it. I'll remember that." Responses are randomized from a pool of Matt-voice acks: "got it", "noted", "yeah ok", "locked in", etc.
- **`remember:` rate limit** — Non-admins get 3 uses per 5 minutes. Hit the limit and the bot gets annoyed: "ok I get it, stop telling me things", "my brain is full, come back later". Admins bypass it.

## Persona

- **`read:` is admin-only** — Confirmed. Only users in `ADMIN_USER_IDS` can feed the bot URLs.

## Easter Egg

- **Chipple** — Say "chipple" or "chipples" anywhere in any message. The bot crashes out: three messages in sequence, everything bottled up (Chicago, Boston, Katie's call, therapy, Harvey, all of it), generated fresh each time. Ends with "...anyway" and then goes completely back to normal.
