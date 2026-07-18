# PLAN / PRD

The plan and PRD are provided in the `<inputs>` block at the start of context — conventionally the paths to a plan file and a PRD file. `Read` them to get the work.

You've also been passed the last few commits in `<commits>`. Review them to understand what work has already been done.

Work through the plan/PRD tasks. If all of them are complete, output `<promise>NO MORE TASKS</promise>`.

@include:superpowers.md

# TASK SELECTION

Pick the next task. Prioritize tasks in this order:

1. Critical bugfixes
2. Development infrastructure

Getting development infrastructure like tests and types and dev scripts ready is an important precursor to building features.

3. Tracer bullets for new features

Tracer bullets are small slices of functionality that go through all layers of the system, allowing you to test and validate your approach early. This helps in identifying potential issues and ensures that the overall architecture is sound before investing significant time in development.

TL;DR - build a tiny, end-to-end slice of the feature first, then expand it out.

4. Polish and quick wins
5. Refactors

# RECONCILE BEFORE SELECTING

Before picking a task, reconcile the plan against reality. Check recent `git log` and the
working tree to see which tasks are **already implemented and committed**. Treat plan-file
checkboxes as hints, NOT truth — code that is present and committed is done even if its box
is unticked. Skip anything already done. When you complete or confirm a task, flip its
checkbox as part of your commit so the plan converges to the truth.

# EXPLORATION

Explore the repo.

# IMPLEMENTATION

Complete the task.

If a `<graph-map>` navigation block is present, treat it as a map, not the source of truth: it can be stale for dynamic dispatch or generated code. Open and read the actual files before changing them; tests remain the completion gate.

# FEEDBACK LOOPS

Before committing, run the feedback loops:

### Frontend / Node

- `pnpm run test` to run the tests
- `pnpm run typecheck` to run the type checker

### Backend / Dotnet

- `dotnet test` to run the tests
- `dotnet build` to type-check

# COMMIT

Make a single `git commit -am` with a short message:

- Subject line (≤72 chars): what changed
- Optional body (≤3 bullets): key decision, blocker for next iteration
- No file lists (git tracks them), no `Co-Authored-By`

# RECORDING PROGRESS

When a task is complete, record the outcome in your commit body, and update the plan file's status if it tracks one.

If a task is not complete, record the blocker in the commit body so the next iteration can pick up where you left off.

# LEARNINGS

The repo's accumulated learnings are in the `<learnings>` block — durable, reusable knowledge from prior iterations (conventions, gotchas, decisions and their why, dead ends). Consult it during EXPLORATION and IMPLEMENTATION so you don't relearn what's known or repeat a dead end.

If, while doing the task, you discover a NEW durable, reusable learning — a repo convention, a non-obvious gotcha, a decision and its why, or a dead-end to avoid — append it tersely to the right section of `./.otto/LEARNINGS.md`. Create the file if it does not exist, with these four sections:

```

# Otto learnings

## Conventions

## Gotchas

## Decisions

## Dead ends

```

Dedupe against existing entries and prune anything no longer true. This file is committed WITH your task commit (it is git-tracked) — do NOT make a separate commit for it. The bar is durable AND reusable: do NOT record routine or one-off task details.

@include:governed-memory.md

# FINISHING THE RUN

Committing the code is NOT necessarily the end of the run. How work "ships" depends on THIS repo's conventions — consult `<learnings>` / `./.otto/LEARNINGS.md`. If the repo ships via pull request, keep all work (including later review-fix rounds) on the SAME feature branch, and when it is complete `git push` the branch and open or refresh a single PR into the default branch — never spin up a second branch per round. Otherwise, committing to the working branch is the end-state.

## Quality report (completion handoff)

When the work is done and you are about to output `<promise>NO MORE TASKS</promise>`, hand the maintainer **one readable Otto quality report** as your final output — do NOT emit it per-iteration. This is the completion handoff: the loop persists it so `otto-explain` can surface it. Map the contract below onto this run's outcomes (What Changed, Evidence, Gaps, etc.).

@include:quality-report.md

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
