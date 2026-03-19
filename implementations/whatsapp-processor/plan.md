# Feature: WhatsApp Message Processor

## Summary
Parse WhatsApp export files, clean and normalize messages, and output a structured JSON corpus for use in persona prompt construction.

## Acceptance Criteria
- [x] All three chat files are parsed into a single structured corpus
- [x] Multi-line messages are correctly joined into a single message object
- [x] System messages (group events, encryption notices) are excluded
- [x] Media-only messages are flagged but retained for context
- [x] `<This message was edited>` suffix is stripped from message text
- [x] Unicode artifacts (left-to-right marks) are stripped
- [x] Timestamps are normalized to ISO 8601
- [x] Output is a single JSON file: `corpus.json`
- [x] Each message includes: `chat`, `timestamp`, `sender`, `isMatt`, `isMedia`, `text`
- [x] Script can be run from the command line with no arguments

## Approach
TypeScript script using only Node.js built-ins (no external dependencies). Reads all three `.txt` files from `chat-data/`, parses and cleans each, merges, sorts by timestamp, and writes `corpus.json` to `chat-data/`.

All messages are retained (not just Matt's) so Feature 2 can extract conversation windows around Matt's replies. Media messages are flagged rather than dropped.

The parser uses a line-by-line approach: lines starting with `[` begin a new message; all other lines are continuations of the previous message.

## Tasks
1. [x] Scaffold: `package.json`, `tsconfig.json`, `processor.ts`
2. [x] Implement line parser — detect message start vs continuation, extract timestamp/sender/text
3. [x] Implement cleaners — strip unicode artifacts, edit tags, normalize timestamp
4. [x] Implement system message detection — exclude group events and encryption notices
5. [x] Implement media detection — flag messages that are solely a media omission string
6. [x] Wire up: read all three files, parse, merge, sort, write `corpus.json`
7. [x] Test against all three files and verify output

## Edge Cases & Error Handling
- Multi-line messages: continuation lines (not starting with `[`) are appended to the previous message's text
- Messages that are only `‎image omitted` etc. are flagged `isMedia: true`; text is set to the omission string for traceability
- System messages (sender matches group name, or is a WhatsApp system string) are excluded entirely
- Unknown sender edge cases: if a line starts with `[` but doesn't match the expected pattern, log a warning and skip
- Missing/unreadable files: throw with a clear message

## Dependencies
- Node.js (built-ins only: `fs`, `path`)
- TypeScript + `ts-node` or compile to JS

## Open Questions
- None

## Completed
2026-03-16 — TypeScript processor parses all three chat files into `data/corpus.json`. 50,428 total messages, 11,093 from Matt across mc/gamer/os chats. Handles multi-line messages, CRLF line endings, `\u202F` narrow no-break space in timestamps, unicode LTR marks, edit tags, media flags, and system event filtering. Output path is `data/corpus.json` at project root (chat-data dir is root-owned).
