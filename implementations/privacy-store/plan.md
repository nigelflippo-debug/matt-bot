# Feature: Privacy Store

## Summary
Encrypt sensitive content files at rest so that a compromised Railway filesystem does not expose raw chat messages. The vector indexes remain pointer-only (already the case); the content files (`enriched.json`, `corpus.json`) are encrypted before deployment and decrypted at runtime using a key from env vars.

## Acceptance Criteria
- [ ] `enriched.json` and `corpus.json` are never deployed in plaintext to Railway
- [ ] Encrypted equivalents (`enriched.enc`, `corpus.enc`) are what lives on Railway
- [ ] The bot decrypts both files at startup using `CONTENT_ENCRYPTION_KEY` env var
- [ ] Lore index stores only `{ id }` in Vectra metadata (no raw text), back-compat with existing `lore.json`
- [ ] Existing lore entries survive without data loss
- [ ] An `encrypt.js` local script produces the `.enc` files from plaintext
- [ ] Plaintext data files are gitignored / not deployed
- [ ] If `CONTENT_ENCRYPTION_KEY` is missing or wrong, the app fails fast with a clear error

## Approach
AES-256-GCM using Node's built-in `crypto` module. No new dependencies.

- `CONTENT_ENCRYPTION_KEY` = 32-byte hex string in env (64 hex chars). Set in `.env` locally and Railway env vars.
- Encryption format: `iv (12 bytes) || authTag (16 bytes) || ciphertext` — all written as a single binary `.enc` file.
- `encrypt.js` is a local-only utility script. It reads plaintext → writes `.enc`. Run once after each corpus rebuild.
- `retrieve.js` loads `.enc` files at startup, decrypts into memory. Falls back to plaintext `.json` if `.enc` not found (local dev convenience).
- Lore index fix: change `upsertItem` metadata from `{ id, text }` to `{ id }`. Retrieval already does an ID-lookup from `lore.json` so removing `text` from the index is transparent.

### Why AES-256-GCM?
- Built into Node — no new deps
- Authenticated encryption: detects tampering/wrong key at decrypt time (authTag check)
- Fast enough for startup decryption of ~10K records

### Threat model covered
- Railway filesystem compromise: attacker gets `.enc` files but not the key
- Attacker gets the key but not the files: useless
- Both: same as no encryption — this is the residual risk, mitigated by Railway's secret management

### What is NOT covered
- Content in memory (acceptable — threat is at-rest disk access)
- `lore.json` (user-curated group knowledge, low sensitivity, different risk profile)
- Logs (separate concern)

## Tasks
1. [x] Write `implementations/rag/crypto-utils.js` — `encryptFile(src, dest, key)` and `loadEncryptedJson` using AES-256-GCM
2. [x] Write `implementations/rag/encrypt.js` — CLI script: reads plaintext `.json` files, writes `.enc` files
3. [x] Modify `retrieve.js` — load `.enc` files (decrypt at startup); fall back to `.json` for local dev
4. [x] Fix `lore-store.js` — change lore index `upsertItem` to store `{ id }` only (back-compat: existing lore.json unaffected)
5. [x] Add `CONTENT_ENCRYPTION_KEY` to `.env` (generate a random 64-char hex key)
6. [x] Update `.gitignore` to exclude plaintext `data/enriched.json` and `data/corpus.json` from the repo
7. [x] Run `npm run encrypt` locally to produce `data/enriched.enc` and `data/corpus.enc`
8. [x] Verify bot starts and retrieves correctly with encrypted files
9. [x] Update `package.json` scripts: add `npm run encrypt`
10. [ ] Update Railway env vars with `CONTENT_ENCRYPTION_KEY`
11. [ ] Redeploy — confirm plaintext files are absent from Railway

## Migration (existing Railway deployment)
The plaintext `enriched.json` already exists on Railway from a prior deploy. Steps to migrate:
1. Complete tasks 1–9 locally
2. Set `CONTENT_ENCRYPTION_KEY` in Railway env vars
3. Push — Railway will deploy the `.enc` files and the updated `retrieve.js`
4. After confirming the bot works, manually delete `enriched.json` from Railway filesystem (or redeploy without it)

## Edge Cases & Error Handling
- Wrong key: GCM authTag verification fails → throw with `"Content decryption failed: invalid key or corrupted file"` — never silently serve garbage
- Missing `.enc` file in production: fail fast with clear error (don't silently fall back to plaintext on Railway)
- Missing `.enc` file in local dev: fall back to plaintext `.json` (convenience)
- Local dev without a key: fallback to plaintext — dev never needs the key

## Dependencies
- Node.js `crypto` (built-in)
- No new npm packages

## Open Questions
- None
