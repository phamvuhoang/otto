# Review follow-ups

## 2026-06-16 — issue #5 review (`.otto/reviews/issue-5-review.md`)

- **#2 `preflight.ts:69` claude-auth false positive** (medium-high) — deferred:
  the review's suggested fix (probe `~/.claude/.credentials.json`) regresses on
  macOS, where `claude /login` stores the OAuth token in the Keychain and that
  file is never written → false negative. A correct cross-platform login probe
  (inspect `~/.claude.json` `oauthAccount`, or platform-specific keychain check)
  is larger than a one-line path swap; needs design.
- **#3 `preflight.ts:91` gh-auth false positive** (medium) — deferred, same
  class as #2; also should honour `GH_CONFIG_DIR` and probe `hosts.yml`.
- **#4 `loop.ts:359` abort during `--cooldown` mislabels as `stopped (error)`**
  (medium-low) — FIXED: the outer catch now checks `activeSignal.aborted` and
  routes through `summarize("aborted", completedIterations)`, returning cleanly
  without rethrow, mirroring the inner mid-stage abort guard.
- **#5 `preflight.ts:37` `whichBin` uses `existsSync` only** (low) — deferred:
  a directory/non-executable named `claude`/`gh` on PATH reports a false `✓`.
  Harden with `statSync().isFile()`.
- **#6 `loop.ts:327` stage failure `break`s only the inner loop** (low,
  pre-existing) — design-intent question, not a diff regression. "Keep going
  after a failed stage" appears intentional; flag for product confirmation, no
  code change.

## 2026-06-16 — issue #12 review (`.otto/reviews/issue-12-review.md`)

- **#1 `RELEASING.md:204` LICENSE not shipped in tarballs** (medium) — deferred:
  `LICENSE` lives only at repo root, so neither published package ships it (only
  the `"license": "MIT"` field). Real MIT-compliance gap. Proper fix = add a
  `LICENSE` to each package dir + `files` array (a packaging change beyond this
  docs run); quick fix = correct the doc claim. Recommended to action before a
  broad public push.
- **#2 `package.json:17` `node --test scripts/*.test.mjs` glob fragile** (low-
  medium) — deferred: native `--test` glob is Node 21+, engines floor is `>=20`,
  and Windows `cmd.exe` doesn't expand it → local Windows root suite errors/runs
  nothing (CI on ubuntu unaffected). Fix: explicit list, glob runner, or raise
  engines floor.
- **#3 `contributing-extension-points.test.mjs:26` stage-name regex over-matches**
  (low-medium) — deferred: `/name:\s*"([^"]+)"/g` greps the whole `stages.ts`, so
  a rename leaving the old string anywhere (comment/alias/template path) passes
  falsely. Scope the parse to the `STAGES` object.
- **#4 `security-doc-contract.test.mjs:103` pins a comment, not behavior** (low-
  medium) — deferred: the `SECURITY INVARIANT…INPUTS…substituted LAST` regex
  passes if `INPUTS` is moved to substitute first but the stale comment stays.
  Pin the actual tag-expansion order, not the comment text.
- **#5 `releasing-contract.test.mjs:73` workflow regex misses `.yaml`** (low) —
  deferred: `/[\w-]+\.yml/g` drops `.yaml` workflows and only forward-checks;
  add `.yaml` and a reverse "all real workflows are named" check.
- **#6 `beta-feedback-contract.test.mjs:38` author-controlled tautology** (low) —
  deferred (largely inherent): rubric axes are literals checked against
  author-written docs; no source-of-truth parse of the issue. Accept as a
  process-doc smoke test.

## 2026-06-16 — issue #14 review (`.otto/reviews/issue-14-review.md`)

- **#5 `linear-cli.ts:168` `dump` does an N+1 sequential fetch storm** (efficiency)
  — deferred: a perf optimisation, not a correctness bug. Properly fixing it means
  widening the `listIssues` GraphQL query to select `description` + a bounded
  `comments { nodes }` and collapsing 1+N round trips to one request; a cheaper
  `Promise.all` of the per-issue calls is possible but still re-fetches. Out of
  scope for a single-finding fix; revisit if dump latency / rate-limits bite.
- **#7 host deps duplicated across `linear-api.ts`/`linear-cli.ts`/`linear-auth.ts`**
  (cleanup) — deferred: the identical `readFile`-returns-null + `home: homedir()`
  defaults and `out`/`err` line-writers repeat across three modules. A shared
  `readFileOrNull`/default-host helper is a cross-module refactor touching stable
  code; safe to batch with the next provider rather than churn now.
- **`runWatch` doesn't thread `mode` into `runLoop`** (`watch.ts:227`, low) —
  deferred: Linear watch persists `state.json` under default `mode: "afk"` so
  `matchesResume` won't resume across watch/non-watch runs. Pre-existing for ghafk
  watch too; the Linear caller inherits it. Low impact, not a diff regression.
- **`wasIdle` resets on every failed poll** (`watch.ts:214`, low) — deferred:
  alternating poll-failure/empty-queue cycles re-announce the idle banner the
  latch suppresses. Minor log noise, pre-existing.
