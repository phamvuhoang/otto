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

When every actionable finding has been addressed (fixed, or already fixed in git, or recorded as a follow-up), output `<promise>NO MORE TASKS</promise>`.

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

For each Deferred / follow-up finding, append a terse entry to `./.otto/review-followups.md` (create it lazily). Use a dated `##` heading for this review, then one bullet per finding with its severity and why it is deferred. This file is git-tracked — commit it WITH the related fix (do not make a separate commit just for it).

# COMMIT

Make a single `git commit -am` with a short message:

- Subject (≤72 chars): `fix(review): <what changed>`
- Body: which finding (and its review section), key decision, and a one-line note of any follow-ups recorded.
- No file lists, no `Co-Authored-By`.

# FINAL RULES

ONLY ADDRESS A SINGLE FINDING per iteration.
