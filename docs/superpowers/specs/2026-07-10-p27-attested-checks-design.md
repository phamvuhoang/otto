# Spec — P27: Harness-attested feedback loops (attested checks)

Source roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P27 and "First Phase 6
Implementation Slice" (steps 1–5). Phase 6 tracking issues are filed when this
slice starts. Prior epic: [Phase 5 #183](https://github.com/phamvuhoang/otto/issues/183).

**Opt-in via `.otto/config.json` `checks`. Absent config ⇒ byte-for-byte no
behavior change.**

## Problem

Every "the suites pass" claim in every review path is agent prose the harness
never verifies. The 2026-07-10 audit confirmed it:

- The single reviewer is told to "Run feedback loops" and commit
  `fix(review):` (`templates/review.md:50-52`); panel synth the same
  (`templates/review-synth.md:26-29`); apply-review per finding
  (`templates/apply-review.md:59-67`); the verify stage is told to "RUN THE
  SUITES ... Record pass/fail counts" (`templates/verify.md:34-36`). None of
  these executions is observed by the harness — the claim is whatever the
  agent writes.
- The only place Otto executes a check itself is `bench.ts`
  `runFixtureChecks` (`bench.ts:210-219`, exit-0 = pass, injectable
  `CheckRunner` at `:193-201`) — and that is eval-only.
- `verification-matrix.ts` validates that a cited artifact **exists**
  (`verification-evidence.ts` `validateVerificationEvidence`), but a
  `method:"test", result:"pass"` row is never re-executed — existence of a
  path, not truth of an outcome.
- Downstream consumers inherit the blind spot: eval `succeeded` is
  exit-reason-only (`eval.ts:54-69`), the quality report's verdict is the
  agent's own text (`report-finalize.ts`), and adaptive iteration control
  hardcodes `failingChecks`/`failureSignature` to `null` (`loop.ts:1542-1557`
  — P28's problem, but it needs P27's records to exist first).

So a `fix(review):` commit that broke the build is accepted on the agent's
word, the report says "working", and eval scores the run a success.

## Goal

Every fix commit in a review path is followed by harness-executed check
commands whose exit code, duration, output tail, and failure signature are
recorded as first-class evidence — and every downstream surface (run report,
`otto-inspect`, eval `succeeded`, the `--verify` matrix) reads the attested
result, not the claim. When the agent claims pass and the harness observed
fail, the run says so explicitly and cannot be reported as working.

## Decisions (locked in brainstorming)

1. **The shared contract is fixed.** P28 (regression signals) consumes these
   exact shapes; they ship verbatim and later slices import, never redefine:

   ```ts
   export type ChecksRecord = {
     command: string;
     exitCode: number;
     durationMs: number;
     outputTail: string;
     failureSignature: string | null;
     attestedAt: string;
   };
   export function runConfiguredChecks(
     commands: string[],
     cwd: string,
     timeoutMs?: number
   ): ChecksRecord[]; // impure
   export function extractFailureSignature(outputTail: string): string | null; // pure
   export function summarizeChecks(records: ChecksRecord[]): {
     passed: number;
     failed: number;
     failureSignatures: string[];
   }; // pure
   ```

   `StageRecord` gains optional `checks?: ChecksRecord[]`; `RunManifest`
   gains optional `checksSummary?: { passed; failed; failureSignatures }` —
   both mirroring the `inputSharpness` optional-manifest-field pattern
   (`run-report.ts:178-182`): absent for every run that never attested.
   `runConfiguredChecks` keeps the contract arity but takes **trailing
   optional** injection params (runner, policy) exactly like
   `runFixtureChecks(checks, cwd, run = defaultCheckRunner)` does, so CI
   tests never spawn.

2. **Reuse the bench pattern, don't reinvent CI.** exit-0 = pass, null
   status (signal-kill / spawn failure) = fail (`exitCode: -1`), commands run
   through `resolveShell()` with `cwd = workspaceDir`. The harness runs the
   repo's _configured_ commands at _defined boundaries_; no check discovery,
   no matrix builds, no flaky-test management (roadmap non-goal).

3. **Policy-scoped, fail-closed.** Each configured command passes
   `checkCommand` (`safety-policy.ts:104-115`) before it spawns. A blocked
   command is **never executed** and is recorded as a failed `ChecksRecord`
   (`exitCode: -1`, output tail names the violation) — a repo that blocks
   its own checks surfaces the misconfiguration loudly instead of silently
   skipping attestation. Output tails are truncated to the **last 2000
   chars** before recording.

4. **Attest fix commits, not every stage.** The boundary predicate is pure
   (`shouldAttestChecks`): checks configured AND the stage is `reviewer` or
   `apply-review-implementer` AND HEAD moved during the stage. Panel synth
   attests via a callback threaded into `runPanel` next to the existing
   post-synth HEAD/dirty git checks (`panel.ts:399-421`), attached to the
   synth substage record — the umbrella reviewer record is already skipped
   for panels (`loop.ts:1445`). A reviewer that says `<review>OK</review>`
   without committing runs nothing (no fix commit to attest, no extra spend).

5. **`--verify` re-executes only allowlisted commands.** A `method:"test"`
   matrix row is re-executed **only when its `check` command exactly matches
   a configured `checks` entry** — the repo-authored config is the
   allowlist, so agent-emitted command strings are never executed verbatim
   (taint stance). An attested failure overrides a reported `pass` to
   `fail` with an explanatory note; the record lands on the row as a new
   harness-only `attestedCheck` field (like `artifactExists` — set by the
   loop, never parsed from agent JSON, `verification-matrix.ts:153-179`).

6. **Disagreement cannot read as working.** `finalizeReportText` renders an
   "Attested Checks" section next to the agent's claims, and when any
   attested check failed it inserts an explicit attestation-override note
   into the `## Verdict` section. Eval `succeeded` becomes exit-reason
   success AND (no attestation OR zero attested failures), so the truth
   signal flows into `otto-eval compare`.

## Scope

**In scope:**

- **Config contract** — `checks: string[]` in `.otto/config.json` (e.g.
  `["pnpm -r typecheck", "pnpm -r test"]`), read by a tolerant
  `readChecksConfig` mirroring `readSkillsConfig`
  (`skill-activation.ts:49`). Absent/malformed ⇒ `[]` ⇒ every P27 seam is
  inert.
- **Pure `packages/core/src/checks.ts`** — `ChecksRecord`,
  `extractFailureSignature` (ANSI-stripped, duration-normalized, stable
  first-failure-line signature), `summarizeChecks`, `shouldAttestChecks`
  (boundary predicate), plus the impure `runConfiguredChecks` behind an
  injectable `CheckCommandRunner` (the `bench.ts:193-201` seam).
- **Evidence shapes** — `StageRecord.checks?` (`run-report.ts:114-142`) and
  `RunManifest.checksSummary?` (`run-report.ts:150-191`); the `recordStage`
  closure (`loop.ts:561-606`) and the panel `recordStage` callback
  (`panel.ts:177-182`) each gain an optional `checks` param, spread like
  `reviewSeverity` (`loop.ts:595-597`).
- **Attestation boundaries**, all gated on a non-empty `checks` config:
  - after the single reviewer's `fix(review):` commit (HEAD moved during the
    `reviewer` stage);
  - after the panel synth's `fix(review):` commit (callback threaded into
    `runPanel`, fired iff `committed`, `panel.ts:399-404`);
  - after each `apply-review-implementer` iteration commit (same predicate,
    different gate stage — `stages.ts:61-63`, wired via `run-bin.ts:628`);
  - in `--verify` finalize, re-execution of allowlisted `method:"test"` rows
    (`reattestTestRows`) between `validateVerificationEvidence` and the
    manifest build (`loop.ts:810-865`).
- **Disagreement surfacing** — `finalizeReportText`
  (`report-finalize.ts:341-355`) appends an "Attested Checks" section and,
  on any attested failure, an attestation-override note inside `## Verdict`;
  the harness fallback report already says "Needs human review". Eval
  `succeeded` incorporates `checksSummary` and a new
  `attestedCheckFailures: number | null` signal + `COMPARE_COLUMNS` entry
  (`eval.ts:113-168`) make it comparable.
- **Rendering** — `otto-inspect` (`inspect.ts` `formatRunReport`) prints a
  manifest-level `checks:` line and per-stage `check:` lines next to the
  stage rows the claims came from.
- **Eval disagreement fixture** — a CI unit fixture: a trajectory with
  `exitReason: "complete"` and `checksSummary.failed > 0` scores
  `succeeded: false` while `exitReason` alone says success.
- Docs: `README.md`, `docs/ARCHITECTURE.md`, and the
  `docs/HARNESS_ROADMAP_PHASE6.md` status line.

**Out of scope (later slice / other initiative):**

- Feeding `failingChecks`/`failureSignature`/`findingSignatures` into
  `deriveProgress`/`decide` (P28 — it consumes this slice's records).
- Attesting implementer commits in afk/ghafk/linear chains (the roadmap
  scopes P27 to review/verify/apply-review paths; broadening is a cost
  decision for later evidence).
- Template changes — the agents' own feedback-loop instructions stay; the
  harness attests independently of what the agent claims.
- Executing agent-emitted matrix `check` commands that are not in the
  configured allowlist (they remain existence-checked only, unchanged).
- Check discovery, per-language defaults, flaky-retry logic, parallel check
  execution.

No new npm dependencies. ESM `.js` relative imports preserved (NodeNext).

## Testable success criteria

Pure/CI (must pass in `pnpm -r test`, no real command spawns):

1. `extractFailureSignature` returns a stable signature (ANSI stripped,
   whitespace collapsed, durations normalized) for vitest/tsc failure
   output, and `null` when no failure marker is present; `summarizeChecks`
   tallies pass/fail and dedupes failure signatures.
2. `runConfiguredChecks` (stub runner): exit-0 → `failureSignature: null`;
   nonzero → non-null signature; null status → `exitCode: -1`; output tails
   truncated to the last 2000 chars; a policy-blocked command is recorded as
   a failure **without the runner ever being invoked**.
3. `shouldAttestChecks` fires only for `reviewer` /
   `apply-review-implementer` with checks configured and HEAD moved — false
   on any other stage, unmoved HEAD, or empty config (the inertness
   guarantee).
4. A `StageRecord` with `checks` and a `RunManifest` with `checksSummary`
   round-trip through `writeStageRecord`/`readStageRecords` and
   `writeManifest`/`readManifest`; `formatRunReport` renders them; records
   without them render byte-identically to today.
5. `finalizeReportText`: an agent report whose verdict claims "Working"
   plus a manifest with `checksSummary.failed > 0` gains the attestation
   override inside `## Verdict` and an "Attested Checks" section; zero
   failures ⇒ section without override; no `checksSummary` ⇒ no new section.
6. `scoreTrajectory`: `exitReason: "complete"` + `checksSummary.failed: 1`
   ⇒ `succeeded: false`, `attestedCheckFailures: 1` (the disagreement
   fixture); no `checksSummary` ⇒ today's exit-reason behavior and
   `attestedCheckFailures: null`; `compareTrajectories` shows the column.
7. `reattestTestRows`: a `method:"test", result:"pass"` row whose command
   the injected attestor fails is downgraded to `fail` with an
   `attestedCheck` record and note; non-test rows and non-allowlisted
   commands are untouched.

Run-level (manual/e2e, not CI-gated):

8. On a repo with `checks` configured, a review-path fix commit yields a
   stage record carrying `ChecksRecord`s, a manifest `checksSummary`, and an
   inspect/report rendering of both; the same run with the config removed is
   byte-for-byte unchanged (roadmap success metrics 1 and 4).

## Non-goals / risks

- **Do not become a second CI.** Only the repo's configured commands, only
  at the defined boundaries. No discovery, no retries, no parallelism.
- **Do not execute untrusted command strings.** Only `.otto/config.json`
  `checks` entries ever spawn — matrix rows re-execute solely on exact
  allowlist match, and every command passes `checkCommand` first.
- **Do not let attestation cost surprise operators.** Checks run only after
  fix commits (HEAD moved), never on `<review>OK</review>` passes; the
  stderr line shows what ran and how it exited.
- **Do not weaken the evidence model.** `attestedCheck` /
  `checks` / `checksSummary` are harness-set only — `coerceEntry` and the
  agent JSON path never populate them (same stance as `artifactExists`).
- **Risk: slow suites double run time on fix-heavy runs.** Mitigation:
  per-command timeout (default 10 min, `timeoutMs` param), and the operator
  chooses the command list (a fast `typecheck`-only config is valid).

## Task outline (detailed in the plan)

1. Pure checks core: `ChecksRecord` + `extractFailureSignature` +
   `summarizeChecks` (+ tests).
2. Config + policy-scoped runner: `readChecksConfig` + `CheckCommandRunner`
   - `runConfiguredChecks` with truncation and fail-closed policy screening
     (+ stub-runner tests).
3. Evidence shapes: `StageRecord.checks` + `RunManifest.checksSummary` +
   `otto-inspect` rendering (+ round-trip tests).
4. Loop attestation at the review boundary: `shouldAttestChecks` + wiring
   for single reviewer, panel synth (callback), and apply-review
   (+ predicate tests) — the roadmap's "one boundary first" lands here.
5. Disagreement surfacing in the finalized report (+ tests).
6. Eval truth signal: `succeeded` incorporates attested results,
   `attestedCheckFailures` signal + compare column + disagreement fixture
   (+ tests).
7. `--verify` re-execution: `reattestTestRows` + finalize wiring (+ tests).
8. Docs + roadmap status + full verify.
