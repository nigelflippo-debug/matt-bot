# matt-bot

## Project Structure

```
matt-bot/
├── CLAUDE.md           # This file — project instructions for Claude
├── sops/               # Standard Operating Procedures
├── skills/             # Reusable skill definitions and prompts
├── context/            # Context files (personas, background, domain knowledge)
├── implementations/    # Actual implementation code and configs
└── sessions/           # Session resumption files
```

## Directories

- **sops/**: Step-by-step procedures for how the bot should handle specific workflows or tasks
- **skills/**: Modular skill definitions — what the bot can do and how
- **context/**: Background context, personas, system prompts, and domain knowledge
- **implementations/**: Code, configs, and deployable artifacts
- **sessions/**: One markdown file per working session for context resumption

## Sessions

Session files live at `sessions/YYYY-MM-DD-<slug>.md` and capture enough context to resume work without re-reading the whole codebase. At the start of a new session, read the most recent relevant session file. At the end of a session (or at a natural checkpoint), write or update the session file.

Each session file follows the template in `sessions/TEMPLATE.md`.

## Active Projects

At the start of every session, read the most recent session file in `sessions/` relevant to the current task.

### Project overview

@implementations/matt-bot/PROJECT.md

### Feature plans

@implementations/whatsapp-processor/plan.md

@implementations/persona/plan.md

@implementations/rag/plan.md

@implementations/privacy-store/plan.md

## Notes

- Add SOPs in `sops/` as markdown files describing each procedure
- Add skills in `skills/` as markdown or structured files
- Add context documents in `context/` for reference by skills and SOPs
- Add implementation code in `implementations/` with a README per component
- When a new project is added, list it under Active Projects above
