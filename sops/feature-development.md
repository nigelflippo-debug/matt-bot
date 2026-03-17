# SOP: Feature Development

## Purpose

A repeatable process for taking a feature from idea to tested implementation. Ensures requirements are clear, plans are documented, and code is verifiable before shipping.

---

## Phase 1: Define the Feature

**Goal:** Establish a shared, unambiguous understanding of what is being built.

1. Write a one-sentence feature statement:
   > "This feature allows [who] to [do what] so that [why]."

2. Identify the feature's scope boundary — what is explicitly **in** and **out** of scope.

3. Name the feature using a short, descriptive slug (e.g., `user-auth`, `message-routing`). This slug will be used for all related files.

---

## Phase 2: Clarify Requirements

**Goal:** Surface ambiguities and edge cases before any planning begins.

Ask and answer the following for every feature:

- **Inputs:** What data or events trigger this feature? What are valid and invalid inputs?
- **Outputs:** What does success look like? What is returned, stored, or emitted?
- **Error cases:** What can go wrong? How should failures be handled?
- **Dependencies:** Does this rely on external APIs, services, other features, or specific data?
- **Constraints:** Are there performance, security, rate limit, or compatibility requirements?
- **Acceptance criteria:** What must be true for this feature to be considered complete?

If any answer is unclear, **stop and ask before proceeding.**

---

## Phase 3: Research & Planning

**Goal:** Understand the landscape before writing the implementation plan.

1. Review existing code in `implementations/` for patterns, utilities, or prior work relevant to this feature.
2. Check `context/` for domain knowledge or system constraints that apply.
3. Identify technical approach options and evaluate trade-offs.
4. Select the approach and note the rationale — especially if a simpler or more complex option was rejected.
5. Break the implementation into ordered, discrete tasks. Each task should be independently completable and testable.

---

## Phase 4: Document the Implementation Plan

**Goal:** Produce a written plan before writing any code.

Create a file at:
```
implementations/<feature-slug>/plan.md
```

The plan must include:

```markdown
# Feature: <Feature Name>

## Summary
[One-sentence description]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Approach
[Chosen technical approach and rationale]

## Tasks
1. [ ] Task one — description
2. [ ] Task two — description
3. [ ] Task three — description

## Edge Cases & Error Handling
- [List edge cases and how each is handled]

## Dependencies
- [List any external services, packages, or internal features required]

## Open Questions
- [Any unresolved questions — must be empty before implementation starts]
```

**Do not begin implementation until "Open Questions" is empty.**

---

## Phase 5: Implement

**Goal:** Execute the plan task by task with minimal deviation.

1. Work through tasks in the order defined in `plan.md`. Check off each task as it is completed.
2. Stay within the defined scope. If new requirements surface, **stop** — add them to a follow-up feature rather than expanding scope mid-implementation.
3. Keep changes focused. Each logical unit of work should be a single, reviewable change.
4. If the plan needs to change during implementation, update `plan.md` first, then proceed.

---

## Phase 6: Test

**Goal:** Verify the feature meets all acceptance criteria before it is considered done.

1. Test each acceptance criterion explicitly — not just the happy path.
2. Test all identified edge cases and error conditions.
3. Verify no regressions in existing functionality.
4. If a test reveals a gap in the original plan, update `plan.md` and address it.

---

## Phase 7: Complete

1. Confirm all tasks in `plan.md` are checked off.
2. Confirm all acceptance criteria are met.
3. Update `plan.md` with a brief completion note:
   ```markdown
   ## Completed
   [Date] — [Summary of what was built and any notable decisions made during implementation]
   ```
4. Move or archive the plan if the feature is fully shipped.

---

## Quick Reference

| Phase | Output |
|-------|--------|
| Define | Feature statement + scope boundary |
| Clarify | Answered requirements checklist |
| Research | Chosen approach + task breakdown |
| Plan | `implementations/<slug>/plan.md` |
| Implement | Working code, tasks checked off |
| Test | All criteria verified |
| Complete | Plan annotated with completion note |
