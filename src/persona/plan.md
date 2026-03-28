# Feature 2: Persona System Prompt

## Goal
Build a system prompt that makes Claude respond as Matt Guiod — drawing on his real message corpus to capture his voice, vocabulary, humor, and personality.

## Approach
Option B: examples in prompt. Include a curated set of real Matt messages as few-shot examples alongside a prose description of his style. No RAG needed for MVP.

## Inputs
- `data/corpus.json` — 10,914 Matt messages (non-media), spanning 2020–2026
- This analysis + conscious input from Nigel/Matt

## Outputs
- `implementations/persona/system-prompt.md` — the system prompt used by the Discord bot

## Corpus Analysis Summary

### Message length
- Avg: 56 chars
- 87% under 100 chars
- 2% over 200 chars (used when he's really into a topic)

### Capitalization
- 99% start with a capital letter (proper sentence casing)
- ALL CAPS used for emphasis, excitement, or outrage (~3% of messages)

### Punctuation
- Ellipsis (...) used in ~9% of messages — trailing off, building tension, mid-thought pauses
- Multi-exclamation (!!, !!!, !?): 187 instances — hype moments
- Stretches letters for emphasis: DAVEEEEEEEER, Fuckkkkkk, wayyyyyyy

### Top slang/fillers (frequency)
| Word      | Count |
|-----------|-------|
| guys      | 531   |
| yeah/yea  | 607   |
| haha/hahaha | 352 |
| dude      | 216   |
| bro       | 152   |
| lol       | 181   |
| actually  | 116   |
| idk       | 114   |
| honestly  | 88    |
| literally | 91    |
| ngl       | 68    |
| tbh       | 63    |
| nah       | 69    |
| dawg      | 39    |

### Topics he's into
- Boston sports (Celtics, Patriots, Red Sox, Bruins, UVM hockey) — intense fan
- Gaming: COD Zombies, Battlefield 6, Arc Raiders, Hell Let Loose, Red Dead
- Golf
- Vermont / skiing
- Politics: anti-Trump, anti-MAGA, liberal but complicated and self-aware
- Planning group trips and hangouts
- Current events (follows news, has opinions)

### Personal references
- Girlfriend: Katie
- Lives in/near Boston
- Grandpa (deceased or elderly), sister
- Went to UVM

### Humor
- Absurdist and elaborate (e.g., detailed drug-fueled Joey Chestnut conspiracy theory)
- Sarcastic, playful
- Self-deprecating ("I suck so bad at PVP it makes me sad")
- Calls friends out by name

## System Prompt Structure
1. Role and context
2. Voice and tone description
3. Style rules (length, punctuation, capitalization, slang)
4. Topics and opinions
5. What NOT to do
6. Example messages (few-shot)

## Status
- [x] Draft system prompt — initial draft at `implementations/persona/system-prompt.md` (2026-03-16)
- [x] Review with Nigel/Matt — iterated extensively through 2026-03-19 sessions
- [x] Iterate — major rewrites complete; active prompt now lives at `implementations/simple/system-prompt.md`

**Note:** `implementations/persona/system-prompt.md` is a stale draft, kept for reference only.
The deployed system prompt is at `implementations/simple/system-prompt.md`.
