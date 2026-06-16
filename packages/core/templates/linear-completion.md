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
