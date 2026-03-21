# matt-bot

## Project Structure

```
matt-bot/
├── CLAUDE.md        # This file — project instructions for Claude
├── docs/            # Plans, SOPs, and project documentation
│   ├── plans/       # Feature design documents
│   ├── sops/        # Standard Operating Procedures
│   └── PROJECT.md   # Project overview and architecture
├── src/             # All source code
│   ├── discord-bot/ # Discord event handling, commands
│   ├── rag/         # Retrieval, generation, lore, encryption
│   ├── simple/      # Test harness (simple pipeline)
│   └── whatsapp-processor/ # Corpus parser (one-time build tool)
├── data/            # Encrypted data files (.enc) and vector indexes
└── sessions/        # Session resumption files (gitignored)
```

## Key References

### Project overview

@docs/PROJECT.md

### Feature plans

@docs/plans/rag.md

@docs/plans/whatsapp-processor.md

@docs/plans/privacy-store.md

## Sessions

Session files live at `sessions/YYYY-MM-DD-<slug>.md` and capture enough context to resume work without re-reading the whole codebase. At the start of a new session, read the most recent relevant session file.

## Notes

- Source code goes in `src/` with a subdirectory per component
- Feature plans go in `docs/plans/`
- SOPs go in `docs/sops/`
- Sensitive content (corpus, system prompt, lore) is encrypted — never commit plaintext
