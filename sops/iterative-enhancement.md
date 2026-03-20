# SOP: Iterative Enhancement

## Purpose

A repeatable process for researching, refining, and iterating on an existing architecture. Used when the system is working but quality, accuracy, or behavior needs improvement — not when building a new feature from scratch.

Distinct from feature development in that the scope is fuzzy at the start. The goal is to move from "something feels off" or "this could be better" to a concrete, measured improvement.

---

## Phase 1: Characterise the Problem

**Goal:** Understand what is actually happening before deciding what to change.

1. Write a one-sentence problem statement:
   > "The system [does X] when it should [do Y] because [hypothesis]."

2. Classify the problem type — this determines where to look:
   | Type | Description | Where to look |
   |------|-------------|---------------|
   | Quality | Output is technically correct but not good enough | Prompts, examples, retrieval |
   | Accuracy | Output is factually wrong or inconsistent | Lore store, context window, persona |
   | Coverage | System misses cases it should handle | Edge case handling, input filtering |
   | Noise | System handles cases it shouldn't | Filtering, classification thresholds |
   | Performance | System is slow or expensive | Batching, caching, model choice |
   | Reliability | System fails intermittently | Error handling, retries, fallbacks |

3. Identify how you know the problem exists:
   - Observed in logs (cite the stage and field)
   - Reported by a user (note who and what they said)
   - Inferred from output quality (describe the pattern)

   **If you can't point to evidence, stop. Characterise before changing.**

---

## Phase 2: Instrument Before You Investigate

**Goal:** Make sure you can see what the system is doing before you try to fix it.

1. Check whether relevant logging exists for the area you're investigating. Can you answer:
   - What input triggered the behavior?
   - What decision was made and why?
   - What was the output?

2. If logging is missing or insufficient, **add it first** before making any behavioral changes. Changing code without observability means you won't know if your fix worked.

3. Deploy the logging change and collect at least a few real examples before proceeding.

---

## Phase 3: Identify the Root Cause

**Goal:** Trace the problem to its actual source, not a symptom.

Work backwards from the observed bad output:

1. **Was the input correct?** Check what was passed to the component that produced the bad output. If the input was already wrong, the fix is upstream.
2. **Was the decision correct given the input?** Check the logic — LLM classification, regex, threshold — that turned the input into a decision.
3. **Was the output correctly handled?** Check how the downstream code acted on the decision.

Common root causes in this system:
- LLM classification is too broad/narrow → tighten the prompt with explicit examples
- Context window includes noise → filter at the call site before passing to the LLM
- Retrieval returns irrelevant results → check embedding quality, scoring, or boost logic
- Confidence thresholds are too permissive → raise the bar for what gets stored or retrieved
- Missing edge case in deterministic logic → add a guard or regex branch

---

## Phase 4: Design the Fix

**Goal:** Choose the minimum change that addresses the root cause.

1. List 2–3 candidate fixes at different levels of complexity.
2. For each, ask:
   - Does it address the root cause or just mask the symptom?
   - Does it introduce new failure modes?
   - Is it back-compatible with existing data?
   - Can it be rolled back if it makes things worse?

3. Choose the simplest fix that addresses the root cause. Document the rationale.

4. If the fix touches stored data or indexes, define the migration:
   - What existing data needs updating?
   - Is the migration a startup script, a one-time script, or manual?
   - What is the fallback if the migration partially fails?

---

## Phase 5: Implement with Observability

**Goal:** Ship the fix in a way that makes it easy to verify it worked.

1. Implement the fix.
2. Add or update logging so the new behavior is visible in Railway logs. Every fix should produce at least one log line that confirms it fired correctly.
3. If the fix involves a new classification or threshold, log both the decision and the input that produced it — not just the outcome.
4. Commit with a clear message explaining *why* the change was made, not just what changed.

---

## Phase 6: Verify

**Goal:** Confirm the fix worked without introducing regressions.

1. After deploying, watch Railway logs for the expected new behavior.
2. Confirm the original bad case no longer occurs (or occurs less).
3. Confirm adjacent behavior is unchanged — check log stages that weren't supposed to change.
4. If the fix involved a migration, verify the migration ran via its completion log entry.

If the fix didn't work or made things worse, **revert before investigating further.** Don't stack unverified fixes.

---

## Phase 7: Reflect and Close

**Goal:** Capture what was learned so the next iteration starts from a better baseline.

1. Update the session file with what was changed and what was observed post-deploy.
2. If the fix revealed a systemic gap (e.g., a whole class of inputs wasn't being filtered), note it as an open question for the next session rather than expanding scope now.
3. If the root cause was a prompt, document the before/after and why the new version is better — this is useful context for future prompt iterations.
4. If the fix is likely to need further refinement, leave a note in the code with a TODO and log the observation pattern to watch for.

---

## Iteration Rhythm

Enhancements in this system follow a tight loop:

```
Observe (logs / user feedback)
    ↓
Hypothesise (root cause)
    ↓
Instrument (if not already visible)
    ↓
Fix (minimum change)
    ↓
Deploy & verify
    ↓
Repeat
```

Resist the urge to batch multiple fixes into one deploy. One change at a time makes it clear which fix caused which outcome.

---

## Quick Reference

| Phase | Question to answer | Output |
|-------|--------------------|--------|
| Characterise | What is the problem and how do we know? | Problem statement + evidence |
| Instrument | Can we see the behavior in logs? | Logging added if missing |
| Root cause | Where in the pipeline does it go wrong? | Specific component + reason |
| Design | What is the minimum fix? | Chosen approach + migration plan |
| Implement | Is the fix observable? | Code + new log lines |
| Verify | Did it work? Did anything break? | Log confirmation |
| Reflect | What did we learn? | Session notes updated |
