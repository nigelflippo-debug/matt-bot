# SOP: Large-Scale Refactoring

## Purpose

A repeatable process for restructuring existing code without changing its external behavior. Used when the system works but its internal structure has become a liability — hard to extend, hard to understand, or drifting from the architecture it should have.

Distinct from feature development (building new things) and iterative enhancement (fixing behavior). A refactor changes *how* the code is organized, not *what* it does.

---

## Phase 1: Articulate the Motivation

**Goal:** Be precise about why the current structure is a problem.

1. Write a one-sentence motivation statement:
   > "The current [area] is structured as [X], which makes it hard to [Y]. It should be [Z]."

2. Classify the motivation — this determines the risk profile:
   | Type | Description | Risk level |
   |------|-------------|------------|
   | Comprehension | Code is hard to follow, responsibilities are tangled | Low — usually safe to restructure |
   | Extensibility | Adding new behavior requires touching too many places | Medium — interfaces may shift |
   | Duplication | Same logic exists in multiple places, drifting over time | Low — consolidation is mechanical |
   | Boundary | Responsibilities are in the wrong module or layer | High — affects imports, data flow, APIs |
   | Data model | Stored data structure doesn't match how it's used | High — migration required |

3. Answer honestly: **what happens if we don't do this?**
   - If the answer is "nothing, it's just ugly" — consider whether now is the right time.
   - If the answer is "the next N features will be painful" — proceed.

---

## Phase 2: Map the Current State

**Goal:** Understand what exists before deciding what to change. Refactoring without a clear picture of current state is how things break.

1. **Identify the scope.** List every file, function, and data structure that will be touched or affected. Be specific — "the retrieval pipeline" is too vague; "retrieve.js lines 40–180, the query enrichment + embedding + search flow" is useful.

2. **Trace the data flow.** For each entry point into the area being refactored, walk the path data takes through the code. Document:
   - What calls what
   - What data is passed at each boundary
   - What side effects occur (logging, storage, external API calls)

3. **Identify the contracts.** What does the rest of the system depend on from this code?
   - Function signatures called from outside the refactored area
   - Data shapes read or written by other components
   - Event emissions, side effects, or timing expectations

4. **Identify the tests.** What existing tests (manual or automated) cover this area? If none exist, note that — you may need to add verification before you start changing things.

Write this up as a **current state document** — it becomes the baseline you verify against.

---

## Phase 3: Define the Target State

**Goal:** Describe what the code should look like when the refactor is complete.

1. Write a **target state description**: what the structure looks like, where responsibilities live, how data flows. Be concrete — name files, modules, and interfaces.

2. **Compare current vs. target** side by side:
   | Aspect | Current | Target | Why |
   |--------|---------|--------|-----|
   | [responsibility / flow / boundary] | [how it works now] | [how it should work] | [what this improves] |

3. **Define the contracts that must be preserved.** These are the invariants — behavior the outside world depends on that must not change:
   - API signatures and return shapes
   - Side effects and their ordering
   - Data format in storage
   - Error behavior (what throws, what returns null, what retries)

4. **Define what is explicitly out of scope.** Refactors tend to expand. Name the adjacent improvements you are *not* making, even if they'd be easy while you're in there.

---

## Phase 4: Assess Risk and Dependencies

**Goal:** Identify what can go wrong and what blocks what.

1. **List every external dependency** of the code being refactored:
   - Other modules that import from it
   - Data stores it reads/writes
   - External APIs it calls
   - Config or environment variables it reads

2. **Identify the blast radius.** If this refactor introduces a bug, what breaks?
   - Just internal behavior? (Low blast radius)
   - User-facing output? (Medium)
   - Stored data integrity? (High — needs migration plan)

3. **Identify ordering constraints.** Which changes must happen before others? Which can be done independently?

4. **Identify rollback difficulty.** For each major change:
   - Can it be reverted with a git revert?
   - Does it involve a data migration that can't be easily undone?
   - Does it require coordinated changes across multiple systems?

---

## Phase 5: Plan the Migration Path

**Goal:** Break the refactor into a sequence of small, safe steps — each leaving the system in a working state.

This is the most important phase. A refactor plan is not "rewrite module X." It is a sequence of incremental changes, each of which:
- Is independently deployable
- Preserves all external contracts
- Can be verified before moving to the next step

### Step design principles

1. **Prepare before you move.** Before relocating logic, introduce the new structure alongside the old one. Dual-write, adapter patterns, or temporary shims let you verify the new path before cutting over.

2. **One concern per step.** Don't rename, restructure, and optimize in the same change. Mechanical changes (renames, moves) should be separate from behavioral changes (new logic, changed flow).

3. **Strangle, don't rewrite.** Wrap or redirect the old code, prove the new path works, then remove the old code. Never delete-and-replace in one step.

4. **Make the change easy, then make the easy change.** If the refactor requires restructuring to be safe, do the restructuring first as its own step.

### Document the plan

```markdown
# Refactor: <Area>

## Motivation
[One-sentence motivation from Phase 1]

## Current State
[Summary or link to current state document from Phase 2]

## Target State
[Summary from Phase 3]

## Preserved Contracts
- [ ] Contract 1
- [ ] Contract 2

## Migration Steps
1. [ ] Step — [description of change and what it achieves]
   - Verify: [how to confirm this step worked]
2. [ ] Step — [description]
   - Verify: [verification]
3. [ ] Step — [description]
   - Verify: [verification]

## Rollback Plan
[How to revert if things go wrong at each stage]

## Out of Scope
- [Things we are not changing]
```

---

## Phase 6: Implement

**Goal:** Execute the plan step by step, verifying at each stage.

1. **Work one step at a time.** Complete a step, verify it, commit it. Do not batch multiple steps into one change — if something breaks, you need to know which step caused it.

2. **Verify after every step.** Run the verification defined in the plan. If the area has automated tests, run them. If it doesn't, manually test the contracts you identified in Phase 3.

3. **Commit with intent.** Each commit message should explain *what* was moved/changed and *why*, referencing the step in the plan. Future readers should understand the migration by reading the commit history.

4. **If the plan needs to change, update it first.** Don't silently deviate. If you discover a step needs to be split, reordered, or added, update the plan document before proceeding.

5. **If a step breaks something, stop.** Revert the step, understand why, and update the plan. Do not push forward through a broken intermediate state.

---

## Phase 7: Verify Completion

**Goal:** Confirm the refactor achieved its target state without regressions.

1. **Walk the contracts checklist.** Every preserved contract identified in Phase 3 — verify it still holds.

2. **Compare against target state.** Does the code match what was described in Phase 3? If there are deviations, are they intentional and documented?

3. **Clean up.** Remove any shims, adapters, dual-write paths, or temporary scaffolding introduced during migration. These should not survive past the refactor.

4. **Check for orphans.** Are there functions, variables, imports, or files that are no longer referenced after the restructuring? Remove them.

5. **Test end-to-end.** If the refactored area is part of a pipeline, run the full pipeline and verify output is unchanged.

---

## Phase 8: Close

1. Update the plan with a completion note:
   ```markdown
   ## Completed
   [Date] — [Summary of what was restructured and any deviations from the original plan]
   ```

2. If the refactor revealed deeper issues that weren't in scope, document them as follow-up work — don't expand scope retroactively.

3. Update any documentation (CLAUDE.md, architecture docs) that references the old structure.

---

## Anti-Patterns

These are the common ways refactors go wrong. Watch for them.

| Anti-pattern | What it looks like | What to do instead |
|---|---|---|
| **Big bang rewrite** | Delete old code, write new code in one step | Strangle pattern — new alongside old, then cut over |
| **Scope creep** | "While I'm in here, I'll also..." | Stick to the plan. Log improvements for later |
| **Invisible progress** | Large PR with hundreds of changed lines | Small, reviewable steps with clear commit messages |
| **Untested migration** | "It compiles, ship it" | Verify contracts at every step |
| **Permanent scaffolding** | Shims and adapters that never get removed | Phase 7 cleanup is not optional |
| **Plan abandonment** | Plan says X, code does Y, nobody updated anything | If the plan changes, update it before proceeding |

---

## Quick Reference

| Phase | Question to answer | Output |
|-------|--------------------|--------|
| Motivate | Why does this need to change? | Motivation statement + classification |
| Map | What does the current code actually do? | Current state document |
| Target | What should it look like when we're done? | Target state + preserved contracts |
| Assess | What can go wrong? | Risk inventory + ordering constraints |
| Plan | How do we get there safely? | Ordered migration steps with verification |
| Implement | Execute one step at a time | Committed, verified changes |
| Verify | Did we arrive at the target state? | Contracts confirmed, cleanup done |
| Close | What did we learn? | Plan annotated, docs updated |
