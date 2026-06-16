# COMPLETION (Linear)

Apply the FINISHING guidance above using the bundled `otto-linear` helper for
every Linear write — never raw GraphQL, and never `gh`:

- **Comment** with branch/PR status or what was done: write the body to a file,
  then `otto-linear comment <ref> --body-file <path>`.
- **PR-based repo (this repo's convention):** comment branch/PR info on the
  Linear issue and leave it OPEN — a human moves it to done when the PR merges.
  Do NOT move the issue yourself.
- **Commit-to-branch repo (no PR):** once the work has landed, move the issue to
  a completed state with `otto-linear done <ref>`. It resolves the target via
  `OTTO_LINEAR_DONE_STATE` (by name), else the team's first `completed`-type
  state. If it cannot resolve one and exits non-zero, comment instead and leave
  the issue for a human to move.

When unsure which convention applies, comment and leave the issue OPEN.

## Quality report placement (Linear)

The FINISHING handoff above already defines the **Otto quality report** shape —
do not re-describe it here. On Linear the **comment body IS that report**: write
the full quality report (verdict, task source, what changed, evidence, human
acceptance checklist, gaps/follow-ups) to a file and post it with
`otto-linear comment <ref> --body-file <path>`, citing the branch/PR, the commit
SHAs, the checks run, and the explicit human next step. For this PR-based repo
that comment is the handoff surface — the issue stays OPEN until the PR merges.
