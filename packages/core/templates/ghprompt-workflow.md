@include:superpowers.md

# RECONCILE BEFORE SELECTING

Before picking an issue, reconcile against reality: check recent `git log` and the working
tree to see whether the work for an open issue is already implemented and committed. If it
is, close/comment on the issue rather than redoing the work. Treat issue checklists as
hints, not truth — committed code is done.

# EXPLORATION

Explore the repo.

# IMPLEMENTATION

Complete the task.

# FEEDBACK LOOPS

Before committing, run the feedback loops:

### Frontend / Node

- `pnpm run test` to run the tests
- `pnpm run typecheck` to run the type checker

### Backend / Dotnet

- `dotnet test` to run the tests
- `dotnet build` to type-check

**If `dotnet test` or `dotnet build` fails with MSB3248** ("Could not resolve assembly reference" / "file is corrupt") — this is a known virtiofs/9p I/O quirk when the repo is mounted from the Windows host. It is NOT a code defect. Do not defer verification. Re-run with build outputs redirected to `/tmp` and parallelism disabled:

```bash
dotnet test <path-to-test-csproj> \
  -m:1 \
  /p:UseSharedCompilation=false \
  /p:BuildInParallel=false \
  /p:BaseIntermediateOutputPath=/tmp/otto-obj/$(basename <path-to-test-csproj> .csproj)/ \
  /p:BaseOutputPath=/tmp/otto-bin/$(basename <path-to-test-csproj> .csproj)/
```

Only if that second attempt also fails may you defer and record the blocker in the commit message.

# COMMIT

Make a single `git commit -am` with a short message:

- Subject line (≤72 chars): what changed
- Optional body (≤3 bullets): key decision, blocker for next iteration
- No file lists (git tracks them), no `Co-Authored-By`

# FINISHING THE RUN

Committing the code is NOT necessarily the end of the run. How work "ships" depends on THIS repo's conventions — consult `<learnings>` / `./.otto/LEARNINGS.md`:

- **If the repo ships via pull request:** keep ALL work for this issue on the SAME feature branch — later review-fix rounds commit onto it too; never spin up a second branch per round. When the work is complete, `git push` that branch and open (or refresh) a single PR into the default branch. Do NOT close the issue yourself — it closes when the PR merges. If the task is not complete, leave a comment on the issue with what was done.
- **Otherwise (the repo's convention is commit-to-branch, no PR):** if complete, close the original GitHub issue; if not, leave a comment with what was done.

When unsure which applies, prefer leaving the issue OPEN and surfacing the branch — never close an issue whose work has not landed on the default branch.

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

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
