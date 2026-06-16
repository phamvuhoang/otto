# Code review — issue #5 (`otto/5`): "Stabilize the core loop"

Date: 2026-06-16 · Branch: `otto/5` vs `main` · Scope: `git diff main...HEAD`

## Summary

Reviewed the 6-commit diff: `preflight.ts` (+ `cli-help`/`index` wiring),
`scratch.ts`, the `loop.ts` summary/cleanup changes, the smoke script, tests,
and docs. Overall **clean, well-tested, well-scoped work** — a pure
dependency-injected preflight module, good unit coverage, and scratch prefixes
verified to match the real writers (`.run-`, `.sandbox-`, `spill-`, `panel-`)
without touching `logs/`/`worktrees/`. The findings below are mostly
medium/low severity; nothing is a release blocker.

Commits in scope:

- `40a10d3` feat(print-config): add preflight diagnostics for run prerequisites
- `e4980b5` fix(review): match test PATHEXT case to filename for win32 whichBin
- `bdfaba7` fix(loop): sweep ephemeral scratch on SIGINT/SIGTERM
- `aeddf55` feat(loop): consistent end-of-run summary across all exit paths
- `4f04970` docs(print-config): document preflight diagnostics block
- `3502a62` feat(smoke): automate pack-then-install release smoke path

## Findings

### 1. `loop.ts:314` — graceful abort mid-stage exits with no summary line (contradicts the PR's own goal)

The PR's stated aim is "one consistent end-of-run summary across **every**
terminal path." But the injected-signal abort path returns silently:

```ts
} catch (err) {
  if (activeSignal.aborted) {
    return { costUsd: runCostUsd, sentinelHit };   // ← no summarize()
  }
```

A caller (e.g. watch mode) that aborts the active stage gets every other path's
summary but not this one. Either route it through `summarize("aborted", …)` or
consciously document that abort is the one silent path.

**Severity:** medium · **Type:** correctness / feature-completeness

### 2. `preflight.ts:69` — `claude auth` is a false-positive heuristic

`pathExists(~/.claude.json) || pathExists(~/.claude)` reports
`✓ credentials found`, but `~/.claude.json`/`~/.claude` are created by `claude`
on first run regardless of login — the real token lives in
`~/.claude/.credentials.json` (per `docs/CONFIG.md`). A user who ran `claude`
but never `claude /login` (or whose token expired) gets a green check, then the
run dies at the first spawn. This directly undercuts the feature's purpose
("catch missing auth before a paid run"). Consider probing
`~/.claude/.credentials.json` specifically.

**Severity:** medium-high · **Type:** correctness (misleading diagnostic)

### 3. `preflight.ts:91` — `gh auth` has the same false-positive shape

`~/.config/gh` exists after any `gh config`/alias use without ever logging in;
the token is in `hosts.yml`. Also ignores `GH_CONFIG_DIR` (relocated config →
false negative). Same class as #2.

**Severity:** medium · **Type:** correctness (misleading diagnostic)

### 4. `loop.ts:359` — abort during the inter-iteration cooldown prints misleading `Otto stopped (error)`

The cooldown `await sleep(wait, activeSignal)` (line 354) sits in the **outer**
try, not the inner stage catch (whose abort guard at line 314 can't reach it).
An abort while idling in `--cooldown` rejects → outer catch →
`summarize("stopped (error)")` + rethrow. A graceful shutdown is reported (and
thrown) as an error. Narrow (needs `--cooldown` set + abort timing) but a real
mislabel.

**Severity:** medium-low · **Type:** correctness (misleading diagnostic)

### 5. `preflight.ts:37` — `whichBin` uses `existsSync` only

No `isFile`/executable-bit check, unlike a real `which`. A directory or
non-executable file named `claude`/`gh` anywhere on `PATH` reports
`✓ claude CLI <path>`, then the run fails with EACCES/"is a directory". Low
likelihood, easy to harden with a `statSync().isFile()` guard.

**Severity:** low · **Type:** robustness

### 6. `loop.ts:327` — stage failure `break`s only the inner loop; the outer iteration loop continues (pre-existing; flag for intent)

On a stage failure after retries, `break` exits the stages loop, then
`completedIterations = i` runs and iteration `i+1` proceeds. A persistently
failing stage burns the whole iteration budget, each broken iteration counted
as "completed," with only the final label reflecting `sawFailure`. This
predates the diff (the PR only added `sawFailure = true`), but since the theme
is loop stabilization, worth confirming this "keep going after failure" is
intended vs. halting.

**Severity:** low · **Type:** design intent (pre-existing)

## Investigated and refuted (not findings)

- **Budget/rate-limit summary `i - 1` counts** — correct; they report
  *completed* iterations, and iteration `i` is genuinely in-progress (its later
  stage did not run).
- **`done` vs `complete` labeling** — intentional: `complete` = sentinel hit,
  `done` = iterations exhausted.
- **Smoke script `--offline` install** — safe. `workspace:^` is rewritten by
  `pnpm pack` to the *same checkout's* core version (`^X.Y.Z`, always satisfied
  by `X.Y.Z`), so no real version drift is possible despite a
  manually-constructed repro.
- **Scratch prefixes** — exhaustive and non-overlapping with the persistent
  `logs/`/`worktrees/` dirs; `cleanScratch` absent-dir and per-entry
  best-effort handling is correct.
- **cli `files` shipping `scripts`** — false alarm: the smoke script lives in
  repo-root `scripts/`, outside the cli package; cli's own `scripts/` holds only
  `afk.sh`/`ghafk.sh`.

## `.gitignore` & uncommitted files

The `.gitignore` is **sound**. It tracks `.otto/` *content* while ignoring the
volatile bits:

```
.otto-tmp/          # scratch — correct
.otto/state.json    # per-run resume state — correct
```

The two untracked files are **not** ignored — they were simply never
`git add`ed, and both are **suitable to commit**:

- **`.otto/config.json`** (`{branchStrategy, branchPrefix}`) — durable *project*
  config, not runtime state or personal data. Belongs in the repo, consistent
  with the gitignore's own comment ("`.otto/` content is tracked, state.json is
  not"). **Commit it.**
- **`docs/ROADMAP.md`** — referenced by `specs/issue-5-design.md` as the source
  of the "Month 1" epic; a standalone doc, not scratch. **Commit it.**

Neither should be added to `.gitignore`.
