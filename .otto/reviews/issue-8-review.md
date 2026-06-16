# Code review — issue #8 (`otto/8`): "Improve maintainer workflows"

Date: 2026-06-16 · Branch: `otto/8` vs `origin/main` · Scope: `git diff origin/main...otto/8`

## Summary

Two code files (`loop.ts`, `watch.ts`) plus docs and tests. Overall solid,
well-decomposed work: the `watch.ts` rename is clean and fully consistent
(nothing outside gitignored `dist/` referenced the old `openIssueCount`), the
documented flags/env vars all exist, the recipe summary strings match
`summarize()`/`nextActionFor()` exactly, and the `fix(review)` commit genuinely
tightened the apply-review assertion. Findings are mostly medium/low — no
blockers. The two worth acting on before the PR are **#1** and **#2**.

Commits in scope:

- `8a0d9da` feat(loop): add next-action hint to end-of-run summary
- `483654f` docs(cli): add mode comparison table (afk/ghafk/verify/apply-review)
- `ec57ebc` docs(cli): add three worked maintainer recipes
- `934c58c` feat(watch): distinguish idle queue from poll/auth failure
- `a2c88db` test(apply-review): pin the follow-up trail contract
- `e2cef21` fix(review): assert fixture-unique substring in apply-review test
- `c014742` feat(summary): tally deferred review follow-ups in end-of-run line

## Findings

### 1. `loop.ts:55` — `countDeferredFollowups` counts all bullets ever recorded, not open deferred work

`countDeferredFollowups` tallies every `/^- /` line, but
`.otto/review-followups.md` is **append-only across dated review sessions and
never prunes resolved items**. The current real file has 5 bullets — one (`#4`)
explicitly marked **FIXED** — so the end-of-run line prints `⚑ 5 deferred
follow-ups` when only 4 are deferred. The number also climbs every review round
regardless of how many were addressed; it measures file age, not outstanding
work. A maintainer is told to chase work that's already done.

**Fix options:** count only genuinely-open items (e.g. exclude bullets whose
text contains `FIXED`/`RESOLVED`, or scope to the latest dated section), or
rename the line to "follow-ups recorded" so the label matches what's counted.

**Severity:** medium · **Type:** correctness (inaccurate diagnostic)

### 2. `watch.ts:170` — idle line now prints on every poll → log-spam regression

The new `else` branch writes `no open issues … idle, next poll in Ns` on every
empty poll. Previously an empty queue printed nothing. At a 30s interval over an
8h overnight watch that's ~960 identical lines (~2880 at 10s), flooding the
detached log and burying the auth/poll-failure signal this PR was built to
surface. Print the idle line once, or only on state transitions
(idle→busy→idle).

**Severity:** medium · **Type:** correctness (behavior regression vs. main)

### 3. `docs/CLI.md:194` — Overnight recipe's `tail` path is never established by the block

The block sets neither `OTTO_WORKSPACE` nor `cd`, so the detached log lands
under `<cwd>/.otto-tmp/logs/` (default workspace = cwd), but the `tail`
hardcodes `~/code/my-repo/.otto-tmp/logs/detached-*.log`. Pasted from any other
directory, `tail` matches nothing. Inconsistent with the Issue-burn-down recipe
(`:143`), which sets `OTTO_WORKSPACE=~/code/my-repo` inline.

**Severity:** medium-low · **Type:** docs (copy-paste failure)

### 4. `docs/CLI.md:167` — External-review recipe's first line isn't a runnable shell command

```bash
/security-review > review.md   # or any reviewer that emits a findings doc
otto-afk --apply-review ./review.md --budget 8 25
```

`/security-review` is a Claude Code slash command, not an executable — a literal
paste fails, creates an empty `review.md`, and feeds it to `--apply-review`. The
inline comment signals it's illustrative, but it sits in a block the section
promises as "copy-pasteable." Use a real placeholder (`your-reviewer >
review.md`) or mark the line as a stand-in.

**Severity:** low-medium · **Type:** docs

### 5. `scripts/cli-docs-recipes.test.mjs:50-60` — weak contract test, blind to drift

The test counts `● Otto ` (≥3) and `→ next:` (≥3) occurrences and
substring-matches flag names, but never asserts the documented summary/hint
strings match the real `summarize()`/`nextActionFor()` output — despite its
comment claiming it pins "the real `summarize()` format." Editing a hint in
`loop.ts` (or a reason string in the docs) leaves them out of sync with the test
still green. The `≥3` thresholds are also partly satisfied by the section's
intro prose, so a recipe could lose its example summary and still pass.

**Severity:** low-medium · **Type:** test quality (false confidence)

### 6. `watch.ts:141` — auth branch drops `poll.detail`, and the matcher is broad

On `poll.auth` the message is the static `gh not authenticated — run 'gh auth
login'` with `poll.detail` discarded. The classifier
`/auth login|not logged|unauthenticated|credential|\b401\b/i` is mostly sound
(`HTTP 401: Bad credentials` matches correctly), but a non-auth gh/git error
containing "credential" flips `auth=true` and suppresses the real error text.
Including `detail` in the auth message makes it robust to misclassification.

**Severity:** low · **Type:** correctness (rare misclassification)

### 7. `loop.ts:57` — `/^- /` also matches list bullets inside code fences/quotes

Same function as #1, separate mechanism: a follow-up entry whose detail quotes an
unindented ```` ```diff ```` block or a left-margin Markdown list inflates the
count. No code-fence awareness.

**Severity:** low · **Type:** correctness (over-count edge)

### 8. `docs/CLI.md:32` — mode table says gate stage `verify`, actual stage is `verifier`

The column's other cells use literal stage names (`apply-review-implementer`,
`ghafk-issue-implementer`), but this cell says `verify`; the registered name is
`verifier` (`stages.ts:29`, template `verify.md`).

**Severity:** low nit · **Type:** docs

## Verified clean (no findings)

- **`watch.ts` rename** — fully consistent; no stale caller, JSDoc/`RunWatchOptions`
  updated, `err.stderr` is a string (`encoding:"utf8"`), no buffer/deadlock risk,
  `!poll.ok` correctly keeps polling.
- **Doc flag accuracy** — every flag/env var in the new table and recipes exists;
  recipe summary lines and `→ next:` hints match `summarize()`/`NEXT_ACTION`
  verbatim.
- **`summarize` double-print** — every call site returns/throws immediately after;
  the new lines print exactly once per run.
- **`fix(review)` commit** — `apply-review.test.ts` now asserts a fixture-unique
  substring (`"deferred, out of scope"`), a real tightening, not a tautology.

## Recommended before opening the PR

1. **#1** — make the deferred count reflect open items (or rename the line).
2. **#2** — throttle the idle watch line.
3. #3–#8 — docs/test polish; safe to fix now or defer with rationale to
   `.otto/review-followups.md`.
