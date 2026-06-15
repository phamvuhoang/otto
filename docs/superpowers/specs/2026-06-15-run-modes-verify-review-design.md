# Design: read-only verify mode + review-driven mode

Date: 2026-06-15
Status: Approved (brainstorm), pending spec review → implementation plan
Applies to: `otto-afk` (both modes are plan/document-driven; `otto-ghafk` unchanged).
Depends on: the resilient-loops feature (PR #29 — `state.json` + `mode` field, the B1
reconcile-against-git playbook rule, `RateLimitError` wait). Implement after that merges;
this branch is cut from `feat/resilient-loops`.

## Problem

Two recurring jobs don't fit the existing implement→reviewer loop:

1. **Re-verify** — confirm an existing plan is actually done without changing anything.
   A real execution report showed the agent _can_ reconcile true progress (git + working
   tree, treating plan checkboxes as hints) and run the suites — but there's no first-class,
   read-only way to ask "is this done, what's missing, what's deferred?" and get a report.
2. **Apply an external code review** — feed a code-review document (findings with
   severities) back to Otto so it fixes the actionable items, tracks the follow-ups, and
   skips the cosmetic ones — instead of a human hand-porting each finding into a plan.

Both are small: a new playbook + a new gate stage + flag wiring. They reuse the resilience
and reconciliation layers; they do **not** fold into that spec.

## Shared mechanism: gate-stage swap

`run-bin.ts` already swaps the gate stage for `--issue`:

```ts
const stages =
  flags.issue != null
    ? ([cfg.issueStage!, ...cfg.stages.slice(1)] as [Stage, ...Stage[]])
    : cfg.stages;
```

Both new modes generalize this: a flag selects an alternate stage chain. The first stage is
always the gate (unchanged loop invariant). Everything else — resilience (rate-limit wait,
`state.json` with `mode`), the B1 reconcile rule, `--review-panel`, `--budget`, `--cooldown`
— is inherited from `loop.ts` with no core change.

```
default          → [implementer,            reviewer]   mode "afk"
--issue           → [ghafkImplementer-issue, reviewer]   (existing)
--verify          → [verifier]                           mode "verify"  (single stage)
--apply-review D   → [applyReviewImplementer, reviewer]   mode "review"
```

`state.json`'s `mode` field (from the resilience feature) records `"verify"` / `"review"`
so resume identity is mode-aware and the two future modes never collide with an afk run.

**Mutual exclusion:** `--verify`, `--apply-review`, `--issue`, and `--watch` are mutually
exclusive; `parseFlags` / `runBin` reject combinations with a clear error (mirrors the
existing `--issue cannot be combined with --watch` guard).

---

## Part A — `--verify` (read-only re-verification)

### Surface

`otto-afk --verify "<plan> <prd>"`. The plan/PRD argument is the same positional `inputs`
as a normal afk run. No iterations argument is needed — verify is one-shot; `runBin` forces
`iterations = 1`. (If a count is passed it is ignored, with a one-line notice.)

### Stage chain

A single new gate stage `verifier` (template `verify.md`), `permissionMode:
bypassPermissions`. No implementer, no reviewer. The loop runs it once and ends.

### Behaviour (`templates/verify.md`)

1. Read the plan/PRD from `<inputs>`.
2. **Reconcile** every task against `git log` + the working tree (the B1 rule): a task whose
   code is present and committed is **done**, regardless of an unticked checkbox.
3. Run the project's test/type suites (read-only) to confirm the implemented work is green.
4. Classify each task: **done** (committed + evidence), **gap** (not implemented / failing),
   or **deferred** (explicitly operational / AFK-deferred, e.g. needs prod creds).
5. Write a report to **`.otto-tmp/verify-<timestamp>.md`** (gitignored scratch) with the
   three sections + per-task evidence (file:line / commit), and echo a summary to stdout.
6. **Make no commits and no source edits.** The only write is the report file under
   `.otto-tmp/`. The playbook states this explicitly; the sandbox runner already confines
   writes to the workspace, and `.otto-tmp/` is gitignored.

No sentinel is required (single pass). `state.json` carries `mode:"verify"`; on normal
completion it is cleared like any run.

### Why a stage, not just `loop.ts` logic

The reconciliation + test-run + classification is agent work (it reads code, runs suites,
judges evidence) — it belongs in a playbook the agent executes, not in the driver. Keeping it
a stage means verify inherits resilience and the existing render/runner path unchanged.

---

## Part B — `--apply-review <doc>` (review-driven fixes)

### Surface

`otto-afk --apply-review code-review.md <iterations>`. The document path becomes `inputs`
(like `--issue` sets inputs to the issue ref). The name is deliberately distinct from the
existing `--review-panel`, which reviews Otto's _own_ diff; `--apply-review` _consumes an
external review_ and fixes it.

### Stage chain

`[applyReviewImplementer, reviewer]` — the normal implement→review loop, but the gate stage
uses a triage playbook. `--review-panel` composes (the panel reviews each fix); `--budget` /
`--cooldown` / resilience all apply unchanged.

### Behaviour (`templates/apply-review.md`)

Read the review document at the path in `<inputs>`. Triage each finding by
actionability/severity, then per iteration pick the next **actionable** finding and:

- **Actionable** (safe, in-scope correctness/cleanup — e.g. "dead code left behind",
  a clear bug) → reconcile against git first (B1 — skip if already fixed), implement the fix,
  run the feedback loops, make one `fix(review): <finding>` commit.
- **Deferred / follow-up** (perf optimisation, operational steps, anything large or
  out-of-scope — e.g. "re-reads 35 days every pull", "backfill mandatory at deploy") →
  append a terse entry to **`.otto/review-followups.md`** (git-tracked; created lazily with
  a dated heading) and commit it with the related fix or as its own `chore(review):` note.
  Do not implement now.
- **Low / cosmetic / won't-fix** (e.g. "totals diverge cosmetically", "low real-world
  risk") → record in the final summary as skipped-with-reason; take no action.

Gate: when no **actionable** findings remain, emit `<promise>NO MORE TASKS</promise>` — the
loop completes. The reviewer stage (or panel) runs on each fix as usual.

### Follow-ups file

`.otto/review-followups.md` (git-tracked, beside `LEARNINGS.md` / `config.json`) accumulates
deferred findings so they aren't lost — a durable, reviewable backlog the operator can later
turn into issues or a plan. Format: dated `##` heading per review, terse bullet per finding
with its severity and why it was deferred.

### Triage guidance (in the playbook, not code)

Severity/actionability is a judgement the agent makes from the review's own language
(severity labels, "follow-up", "operational", "cosmetic", "low risk"). The playbook gives the
rubric above; it does not hard-code finding numbers. The agent records its triage decision for
every finding in the final summary so the run is auditable.

---

## Components / file map

- **New** `packages/core/templates/verify.md` — verify playbook (Part A).
- **New** `packages/core/templates/apply-review.md` — triage playbook (Part B).
- **Edit** `packages/core/src/stages.ts` — add `verifier` and `applyReviewImplementer` to
  `STAGES` (template + `bypassPermissions`).
- **Edit** `packages/core/src/cli-help.ts` — `--verify` (boolean) and `--apply-review <doc>`
  (value) flags; help text; mutual-exclusion validation; `--print-config` lines.
- **Edit** `packages/core/src/run-bin.ts` — resolve the mode, swap the stage chain, set
  `inputs`, force `iterations = 1` for `--verify`, pass `mode: "verify"|"review"` to
  `runLoop`; reject mutually-exclusive combinations. **Arg handling:**
  - `--verify` keeps normal afk positional semantics: `inputs = rest[0]` (the plan/PRD),
    `iterations` coerced to `1` (any `rest[1]` ignored with a notice).
  - `--apply-review <doc>` takes the doc as the **flag value**, so `inputs = flags.applyReview`
    (the doc path) and `iterations = rest[0]` — not `rest[1]`. This mirrors how `--issue` sets
    `inputs = String(flags.issue)` and reads the iterations from the remaining positional.
- **Edit** `packages/core/src/main.ts` — wire the alternate stages onto the afk `RunBinConfig`
  (mirroring how `issueStage` is wired for ghafk), e.g. `verifyStage` / `applyReviewStage`
  fields on `RunBinConfig`.
- **Docs** — README (flags + a "Verify & apply-review modes" note), `docs/ARCHITECTURE.md`
  (loop-topology table: the two new chains).

`loop.ts`, `render.ts`, `runner.ts`, the resilience modules — **unchanged**; they receive a
different stage chain / mode string and otherwise behave identically.

## Testing

- `cli-help.test.ts`: `--verify` and `--apply-review <doc>` parse; `--apply-review` requires a
  value; mutual-exclusion errors (`--verify` + `--apply-review`, either + `--issue`, either +
  `--watch`); `--print-config` shows the resolved mode.
- `run-bin` wiring: `--verify` ⇒ single `verifier` stage + `iterations` coerced to 1;
  `--apply-review D` ⇒ `[applyReviewImplementer, reviewer]` + `inputs === D` + `mode:"review"`.
  (Follow the existing run-bin test approach; if none exists, assert via a thin seam or a
  `--print-config` snapshot.)
- Render smoke: `verify.md` and `apply-review.md` render with `{{ INPUTS }}` (+ `{{ RESUME }}`)
  and leak no tags.
- Behaviour itself (reconcile/triage quality) is playbook-driven, like every existing mode —
  not unit-tested.

`pnpm -r typecheck && pnpm -r test && pnpm test` stays green.

## Scope guard

Building: two playbooks, two stages, the flags + gate-swap wiring, the follow-ups file
convention, verify's one-shot report. **Not** building: a `otto-verify`/`otto-review`
separate bin (flags on `otto-afk` chosen), GitHub-issue creation for follow-ups (a local
file chosen), verify for `otto-ghafk` (afk plan-driven only this round), or any change to the
resilience/loop core.
