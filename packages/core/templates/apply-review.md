{{ RESUME }}

<commits>

!?`git log -n 15 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<existing-followups>

!?`cat ./.otto/review-followups.md|||_No follow-ups recorded yet._`

</existing-followups>

<review-doc>

{{ INPUTS }}

</review-doc>

# APPLY REVIEW

`<review-doc>` names a code-review document (a file path). `Read` it. It contains findings, usually with severities. Your job is to fix the actionable ones — ONE finding per iteration — and track the rest.

When every actionable finding has been addressed (fixed, or already fixed in git, or recorded as a follow-up), produce the completion report (see COMPLETION REPORT below), then output `<promise>NO MORE TASKS</promise>`.

# TASK KEY

Per-task artifacts (spec, plan, follow-ups) live together under
`.otto/tasks/<task-key>/`, so everything Otto knows about a task is in one place.
Resolve the task key for THIS run from the current git branch: run
`git branch --show-current` and take the **final path segment** (the part after the
last `/`) — e.g. `otto/issue-21` → `issue-21`, `feat/gh-acme-web-14` →
`gh-acme-web-14`. If the branch name has no `/`, use it whole. Use this key in the
follow-ups path below.

# TRIAGE

Classify each finding (judge from the review's own language — severity labels, "follow-up", "operational", "cosmetic", "low risk"):

- **Actionable** — a safe, in-scope correctness fix or cleanup (e.g. dead code, a clear bug, an incomplete cleanup). Fix it.
- **Deferred / follow-up** — perf optimisation, operational steps, or anything large/out-of-scope (e.g. "re-reads N days every pull", "backfill mandatory at deploy"). Do NOT implement now; record it (below).
- **Low / cosmetic / won't-fix** — note it in your commit body / final message with the reason; take no action.

# RECONCILE BEFORE FIXING

Before fixing a finding, check recent `git log` and the working tree — if it is already fixed, skip it (don't redo committed work). Treat the review as possibly stale.

# FIX ONE FINDING

Pick the highest-value actionable finding not yet addressed. Implement the fix. Run the feedback loops:

### Frontend / Node

- `pnpm run test`, `pnpm run typecheck`

### Backend / Dotnet

- `dotnet test`, `dotnet build`

# RECORD FOLLOW-UPS

For each Deferred / follow-up finding, append a terse entry to the **task-local** follow-ups file `./.otto/tasks/<task-key>/followups.md` (create it and its parent dir lazily), using the task key resolved above. Use a dated `##` heading for this review, then one bullet per finding with its severity and why it is deferred. Keeping follow-ups beside the task's spec/plan means everything Otto knows about a task is in one place, while staying globally summarizable by globbing `.otto/tasks/*/followups.md`.

Read the task-local file first (it may already hold this task's prior deferrals). The legacy global `./.otto/review-followups.md` is still READ as a fallback for older runs (see `<existing-followups>`) for one release, but do NOT append new entries there. This file is git-tracked — commit it WITH the related fix (do not make a separate commit just for it).

# COMMIT

Make a single `git commit -am` with a short message:

- Subject (≤72 chars): `fix(review): <what changed>`
- Body: which finding (and its review section), key decision, and a one-line note of any follow-ups recorded.
- No file lists, no `Co-Authored-By`.

# COMPLETION REPORT

Only on the final iteration — when every actionable finding has been addressed
and you are about to output the sentinel — hand the maintainer one readable
summary of the whole review-fix round. Do NOT emit it per-iteration. Map the
contract below onto this round:

- **What Changed / Evidence:** the findings you CONFIRMED and fixed, each with
  its `fix(review):` commit SHA and the review section it came from; the
  feedback loops you ran (tests / typecheck) and their result.
- **Gaps And Follow-Ups:** findings you DEFERRED to
  `./.otto/tasks/<task-key>/followups.md` (with why), and any REJECTED / won't-fix
  findings with their reason. Verdict
  defaults to **Needs human review** when any actionable finding was left
  unfixed.

@include:quality-report.md

# FINAL RULES

ONLY ADDRESS A SINGLE FINDING per iteration.
