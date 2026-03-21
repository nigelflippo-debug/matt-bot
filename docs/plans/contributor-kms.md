# Feature: Contributor Key Management (SOPS + age)

## Summary
Replace the single shared `CONTENT_ENCRYPTION_KEY` with SOPS + age so multiple contributors can decrypt sensitive files using their own key pairs. No shared secrets, easy revocation.

## Status
Deferred — implement when the first external contributor needs to run the bot locally.

## Current State
- Single AES-256-GCM key (`CONTENT_ENCRYPTION_KEY`) encrypts all sensitive files
- Key is shared via `.env` locally and Railway env vars in production
- `crypto-utils.js` handles encrypt/decrypt with `encryptFile`, `loadEncryptedJson`, `loadEncryptedText`
- Encrypted files: `data/corpus.enc`, `data/enriched.enc`, `data/lore.enc`, `src/simple/system-prompt.enc`

## Proposed State
- Each contributor generates an age keypair (`age-keygen`)
- `.sops.yaml` in repo root lists all authorized public keys
- Sensitive files are encrypted with SOPS to all listed recipients
- Contributors decrypt with their own private age key
- Railway uses a dedicated age key (private key stored as env var)
- Revoking access = remove public key from `.sops.yaml`, re-encrypt

## How age + SOPS Works

### Setup (one-time, per contributor)
```bash
# Install
brew install sops age   # macOS
apt install sops age    # Debian/Ubuntu

# Generate keypair
age-keygen -o ~/.config/sops/age/keys.txt
# Outputs public key like: age1abc123...
# Private key stays in keys.txt, never shared
```

### Repo config (`.sops.yaml`)
```yaml
creation_rules:
  - path_regex: \.enc$
    age: >-
      age1abc123...,
      age1def456...,
      age1ghi789...
```
Each line is a contributor's public key. SOPS encrypts to all of them.

### Encrypt / decrypt
```bash
# Encrypt a file (anyone with .sops.yaml can do this)
sops encrypt --input-type binary --output-type binary data/corpus.json > data/corpus.enc

# Decrypt (uses your private key from ~/.config/sops/age/keys.txt)
sops decrypt --input-type binary --output-type binary data/corpus.enc > data/corpus.json
```

### Adding a contributor
1. Contributor runs `age-keygen`, sends you their public key
2. Add public key to `.sops.yaml`
3. Re-encrypt all files: `sops updatekeys data/corpus.enc` (repeat for each file)
4. Commit updated `.sops.yaml` and `.enc` files

### Revoking a contributor
1. Remove their public key from `.sops.yaml`
2. Re-encrypt all files
3. Rotate the Railway age key if the revoked contributor had production access

## Implementation Tasks

### 1. Install and configure SOPS + age
- Add `.sops.yaml` to repo root with your public key + Railway's public key
- Generate a Railway-specific age keypair, store private key as `SOPS_AGE_KEY` env var

### 2. Re-encrypt existing files with SOPS
- Decrypt current `.enc` files using the existing AES key
- Re-encrypt with SOPS + age
- File format changes: SOPS wraps the ciphertext with its own metadata header

### 3. Update `crypto-utils.js`
- Replace `decryptBuffer` (AES-256-GCM) with SOPS decryption
- Option A: shell out to `sops decrypt` at startup (simplest, requires sops binary in Docker image)
- Option B: use age npm package (`age-encryption`) for native decryption (no external binary)
- Keep the plaintext fallback for local dev without keys

### 4. Update `encrypt.js`
- Replace `encryptFile` with SOPS encryption
- Or remove `encrypt.js` entirely — contributors can run `sops encrypt` directly

### 5. Update Dockerfile
- If Option A: install `sops` and `age` binaries in the image
- If Option B: no Dockerfile changes needed (pure JS decryption)
- Add `SOPS_AGE_KEY` env var for runtime decryption

### 6. Update `.env.example` and docs
- Replace `CONTENT_ENCRYPTION_KEY` with `SOPS_AGE_KEY` (or `SOPS_AGE_KEY_FILE`)
- Update CLAUDE.md encryption section
- Update README setup instructions

## Migration Path
1. Decrypt all `.enc` files with the current AES key
2. Set up `.sops.yaml` with age public keys
3. Re-encrypt with SOPS
4. Update `crypto-utils.js` decryption
5. Test locally and on Railway
6. Remove `CONTENT_ENCRYPTION_KEY` from Railway env vars
7. Add `SOPS_AGE_KEY` to Railway env vars

## Trade-offs

| | Current (AES single key) | Proposed (SOPS + age) |
|---|---|---|
| Contributor onboarding | Share the key | Contributor generates keypair, you add their pubkey |
| Revocation | Change key, re-share with everyone | Remove pubkey, re-encrypt |
| Shared secret | Yes — everyone has the same key | No — each person has their own |
| Dependency | Node crypto (built-in) | sops + age (external binary or npm package) |
| Complexity | Simple | Moderate |
| Docker image size | No change | +10MB if installing sops binary |

## Decision
Not worth the added complexity until there's an actual contributor who needs access. The current single-key approach is fine for a one-person project deployed to Railway.
