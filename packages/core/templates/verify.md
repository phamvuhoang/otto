{{ RESUME }}

<commits>

!?`git log -n 15 --format="%H%n%ad%n%s---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<inputs>

{{ INPUTS }}

</inputs>

# VERIFY (READ-ONLY)

You are VERIFYING, not implementing. The `<inputs>` block names a plan and PRD (conventionally file paths). `Read` them.

**Make NO commits and NO source edits.** You may read files and run the test/type suites. The only file you may write is the report named at the end.

# RECONCILE

For each task in the plan, determine its true status from reality, not from checkboxes:

- Inspect recent `git log` (above) and the working tree. Code that is present and committed is **done** — even if the plan's checkbox is unticked. Treat checkboxes as hints, not truth.
- Cite evidence: the `file:line` or commit SHA that implements the task.

# RUN THE SUITES

Run the project's test and type checks read-only to confirm the implemented work is green. Use the repo's conventional commands (e.g. `pnpm -r test` / `pnpm -r typecheck`; `dotnet test` / `dotnet build`). Record pass/fail counts.

# CLASSIFY

Put every task in exactly one bucket:

- **DONE** — implemented, committed, evidence cited, suites green.
- **GAP** — not implemented, incomplete, or failing. Say what is missing.
- **DEFERRED** — intentionally not done in this environment (operational / needs prod creds / AFK-deferred). Say why.

# REPORT

Write your report to `.otto-tmp/verify-report.md` using the `Write` tool (this path is gitignored scratch — it is the one write you may make). Use the Otto quality report contract below: fold the RECONCILE/CLASSIFY results into it — DONE tasks (with their `file:line`/SHA evidence) into **What Changed** + **Evidence**, the suite pass/fail counts into the Test/typecheck evidence line, and GAP/DEFERRED tasks into **Gaps And Follow-Ups**.

@include:quality-report.md

# CROSS-RUN QUALITY SUMMARY (READ-ONLY)

Beyond _this_ run, give the maintainer a quality rollup **across** runs so they can
spot recurring output-quality failures without reading every NDJSON log. `Read`
`./.otto/verdicts.md` (the git-tracked human-verdict trail). If it is absent, skip
this section. Otherwise append a short `## Cross-Run Quality Summary` block to the
same report file (`.otto-tmp/verify-report.md`) with:

- **Completions:** how many runs recorded a verdict, and the tally per verdict
  (Accepted / Accepted with follow-ups / Rejected / Needs investigation).
- **Common causes:** recurring reasons behind rejections or follow-ups (e.g.
  "scope creep", "thin evidence"), most frequent first.
- **Outstanding gaps & deferred work:** gaps and deferred items still open across
  runs, so a maintainer can turn them into follow-up issues.

Keep it to a few lines and cite the trail entries you counted. This is read-only —
do not edit or commit the trail.

Also print the Verdict + a one-line tally of done/gap/deferred to your final message. Do not commit.
