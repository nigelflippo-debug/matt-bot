# SOP: Prompt-Driven Development

## Purpose

A process for turning a rough idea into a fully architected, documented project plan — before a single line of code is written. This SOP operates at the system level: defining what to build and why, shaping the architecture, and decomposing work into features. Each feature then follows `feature-development.md`.

This SOP is for:
- Starting a new project from scratch
- Adding a significant new capability that spans multiple features
- Rethinking or re-architecting an existing system

---

## Phase 1: Capture the Raw Idea

**Goal:** Get the idea out of your head and into words without filtering or refining it yet.

1. Write a rough description of what you want to build — stream of consciousness is fine.
2. Identify who prompted this idea: a user need, a technical gap, an opportunity, or a constraint.
3. Note any assumptions or instincts already attached to the idea (e.g. "I think this should use X technology").

Do not edit for clarity yet. The goal is to capture intent, not polish it.

---

## Phase 2: Interrogate the Idea

**Goal:** Through structured questioning, transform the rough idea into a well-understood problem statement.

Work through the following question sets. For each, write answers — do not skip ahead.

### The Problem
- What problem does this actually solve?
- Who experiences this problem? How often? How painfully?
- What happens today without this solution?
- Is there a version of this problem that is simpler but still valuable to solve?

### The Goal
- What does success look like in 3 months? In 12?
- What is the minimum version that would be genuinely useful?
- What would make this a failure even if it technically works?

### The Constraints
- What are the hard constraints (budget, timeline, platform, compliance, existing systems)?
- What are the soft constraints (team preferences, conventions, maintainability)?
- What are we deliberately not solving?

### The Unknowns
- What do we not know that could change the direction significantly?
- What are we assuming that hasn't been validated?

If any answers are vague or "unsure", flag them — they become research tasks in Phase 3.

---

## Phase 3: Research

**Goal:** Resolve unknowns and validate assumptions before committing to an architecture.

1. List every flagged unknown from Phase 2.
2. For each unknown, define the minimum research needed to resolve it (a spike, a prototype, reading docs, asking a user).
3. Conduct the research. Document findings — not just conclusions, but what was ruled out and why.
4. Revisit Phase 2 answers after research. Update where findings changed the picture.

Do not begin architecture until all blocking unknowns are resolved. Non-blocking unknowns can be carried forward as documented risks.

---

## Phase 4: Define the System

**Goal:** Establish the high-level architecture and the boundaries of the system being built.

1. Write a **system statement** — one paragraph describing what the system does, for whom, and how it fits into its environment.

2. Identify the **core components**: the major logical parts of the system and their responsibilities.

3. Define the **boundaries**:
   - What does this system own?
   - What does it consume from outside?
   - What does it expose to outside?

4. Draw or describe the **data flow**: how information moves through the system from input to output.

5. Make explicit **architecture decisions** — for each key decision, document:
   - The decision made
   - The alternatives considered
   - The reason this option was chosen

6. Identify **cross-cutting concerns**: auth, error handling, logging, rate limits, data storage — and decide how each is handled system-wide.

---

## Phase 5: Decompose into Features

**Goal:** Break the system into discrete, buildable features.

1. List every capability the system needs to have. Don't worry about order yet.

2. Group capabilities into logical **features** — a feature is a self-contained unit of user or system value.

3. For each feature, write:
   - A one-sentence description
   - Its dependencies (other features it requires to exist first)
   - Its priority: **must-have** / **should-have** / **nice-to-have**

4. Sequence the features into a **build order** based on dependencies and priority.

5. Identify the **walking skeleton** — the smallest set of features that, when built, prove the architecture works end to end.

---

## Phase 6: Document the Project Plan

**Goal:** Produce a single reference document that captures everything decided so far.

Create a file at:
```
implementations/<project-slug>/PROJECT.md
```

The document must include:

```markdown
# Project: <Name>

## Problem Statement
[What problem this solves and for whom]

## System Statement
[What the system does and how it fits its environment]

## Goals & Success Criteria
- [ ] Success criterion 1
- [ ] Success criterion 2

## Out of Scope
- [Explicit list of things we are not building]

## Architecture
### Components
[List of core components and their responsibilities]

### Data Flow
[Description or diagram of how data moves through the system]

### Architecture Decisions
| Decision | Chosen | Alternatives | Rationale |
|----------|--------|--------------|-----------|

### Cross-Cutting Concerns
| Concern | Approach |
|---------|----------|

## Features
| # | Feature | Priority | Depends On |
|---|---------|----------|------------|

## Build Order
1. [Walking skeleton features first]
2. ...

## Risks & Open Questions
| Item | Type | Notes |
|------|------|-------|

## Research Findings
[Summary of what was learned in Phase 3]
```

---

## Phase 7: Kick Off Features

1. Take the first feature from the build order.
2. Follow `sops/feature-development.md` from Phase 1.
3. After each feature ships, return here and update the feature table in `PROJECT.md`.
4. Revisit the build order after each feature — new learnings may shift priorities.

---

## Key Differences from Feature Development SOP

| | This SOP | Feature SOP |
|---|---|---|
| **Scope** | Whole system or major capability | Single feature |
| **Output** | `PROJECT.md` — architecture + feature roadmap | `plan.md` — task list for one feature |
| **Starting point** | Rough idea | Defined feature |
| **Research depth** | Broad — validating assumptions about the problem space | Focused — understanding how to implement a specific thing |
| **Architecture** | Explicit decisions at system level | Follows decisions already made |
| **Done when** | Project is decomposed and sequenced, ready to build | Feature is shipped and tested |
