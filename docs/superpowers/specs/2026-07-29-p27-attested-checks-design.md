# Design: P27 — harness-attested feedback loops

Date: 2026-07-29
Status: Approved (brainstorm), pending spec review → implementation plan
Applies to: every review path (`reviewer`, panel `review-synth`, `apply-review`) and `--verify`, across all loop bins.
Tracking: issue #246 (epic #245). Roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P27.
Supersedes the design decisions embedded in `docs/superpowers/plans/2026-07-10-p27-attested-checks.md` where the two disagree (see [Deltas](#deltas-from-the-2026-07-10-plan)).

## Problem

Every test/typecheck/build outcome in every review path is **agent self-reported**. The harness never executes a check itself outside the eval suite (`bench.ts` `runFixtureChecks` is eval-only). A `fix(review):` commit is accepted on the agent's word that the suites passed, and three downstream systems inherit that unverified claim:

- the run report tells a maintainer "tests pass" with nothing behind it;
- eval `succeeded` is `exitReason != null && SUCCESS_REASONS.has(exitReason)` (`eval.ts:101`) — pure exit-reason, no truth signal;
- P28's iteration control wants `failingChecks`/`failureSignature`, which `loop.ts:1884-1896` hardcodes to `null`.

The target user is a solo maintainer running Otto AFK overnight who needs to trust the morning report without re-running everything.

## Outcome

Every claim that "the suites pass" in a review, verify, or apply-review path is backed by a command the harness itself executed, with exit code, duration, and output signature recorded in the evidence bundle. Absent a `checks` config, runs are byte-for-byte unchanged.

## Architecture

Two modules, following the `panel.ts` / `report-finalize.ts` / `plan-gate.ts` precedent of extracting orchestration rather than growing `loop.ts` (already 1,972 lines):

- **`packages/core/src/checks.ts`** — the pure contract plus the policy-scoped runner. This is the surface P28 imports.
- **`packages/core/src/attestation.ts`** — orchestration: the boundary predicate, the per-boundary ledger, terminal-state resolution, and exit-reason derivation.

`loop.ts` gains two call sites (`attestBoundary` at HEAD-moving stages, `resolveAttestation` at finalize). `panel.ts` gets the same callback beside its existing post-synth git checks. `next-action.ts` and `eval.ts` each gain one case.

The split is load-bearing rather than cosmetic: terminal-vs-cumulative resolution, fail-fast sequencing, and exit-reason override are all **stateful**, and that state belongs somewhere unit-testable without spawning a loop.

### Components

```ts
// checks.ts — the shared P27/P28 contract
export type ChecksRecord = {
  command: string;
  exitCode: number;
  durationMs: number;
  outputTail: string;
  failureSignature: string | null;
  attestedAt: string;
};

export type CheckCommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number
) => { status: number | null; output: string };

export function extractFailureSignature(outputTail: string): string | null;
export function summarizeChecks(
  records: ChecksRecord[],
  configuredCount: number
): {
  passed: number;
  failed: number;
  skipped: number;
  failureSignatures: string[];
};
export function runConfiguredChecks(
  commands: string[],
  cwd: string,
  timeoutMs?: number,
  run?: CheckCommandRunner,
  policy?: SafetyPolicy,
  now?: () => string
): ChecksRecord[];
export function readChecksConfig(workspaceDir: string): string[];
```

```ts
// attestation.ts — orchestration
export type ChecksSummary = {
  passed: number;
  failed: number;
  failureSignatures: string[];
  everFailed: boolean;
  terminalFailed: number;
};

/** Append-only per-run log of what each boundary attested, in fire order.
 *  `resolveAttestation` reads the LAST entry for the terminal verdict and folds
 *  all entries for the cumulative evidence. */
export type AttestationLedger = {
  entries: {
    boundary: string;
    iteration: number;
    configuredCount: number; // captured at attest time so `skipped` is exact
    records: ChecksRecord[];
  }[];
};

/** Everything a boundary needs to run checks; supplied by the loop. */
export type AttestationContext = {
  commands: string[]; // from readChecksConfig, cached per run
  workspaceDir: string;
  policy: SafetyPolicy;
  timeoutMs?: number;
  run?: CheckCommandRunner; // injected in tests
};

export function shouldAttestBoundary(stageName: string): boolean;
export function attestBoundary(
  ledger: AttestationLedger,
  boundary: string,
  iteration: number,
  ctx: AttestationContext
): ChecksRecord[];
export function resolveAttestation(ledger: AttestationLedger): {
  checksSummary: ChecksSummary;
  terminalFailed: number;
  exitReasonOverride: string | null;
};
```

Attestation boundaries are `reviewer`, panel `review-synth`, and `apply-review-implementer` — the three stages that move HEAD in a review path.

### Configuration

```json
{ "checks": ["pnpm -r typecheck", "pnpm -r test"] }
```

A plain string array in `.otto/config.json`, read once per run through a tolerant reader mirroring `contextCompressor` (`context-compressor.ts:150-162`): missing or malformed ⇒ `[]` ⇒ fully inert. Order is meaningful — see fail-fast below.

## Decisions

### D1 — terminal state decides the verdict; cumulative state is evidence

A mid-run failure that a later iteration fixes must **not** sink the run. The review loop exists precisely to turn red into green; scoring that as failure is a false negative on a working run.

```ts
RunManifest.checksSummary?: {
  passed: number;              // cumulative across the run
  failed: number;              // cumulative
  failureSignatures: string[]; // cumulative, deduped
  everFailed: boolean;         // churn evidence — never the verdict
  terminalFailed: number;      // last attestation — drives the verdict
};
```

`succeeded = exitReason ∈ SUCCESS_REASONS && (checksSummary absent || terminalFailed === 0)`.

- iteration 2 red → iteration 5 green ⇒ `succeeded: true`, `everFailed: true`
- iteration 5 red ⇒ `succeeded: false`

The cumulative fields are retained because they are exactly the recurring-failure signal P28 consumes; discarding them would make P28 re-derive what this phase already observed.

### D2 — fail-fast within a boundary

Checks run in configured order and stop at the first non-zero exit. A red `pnpm -r typecheck` (12s) skips the slow suite entirely. Signal fidelity is preserved — every boundary still attests — while wall-clock cost collapses on exactly the runs that are going badly, which is what makes per-iteration attestation affordable on an overnight run.

Unrun commands are **not** recorded as records (that would corrupt the `ChecksRecord` contract P28 imports). They surface as `summarizeChecks(...).skipped`, so the report can say `1 of 2 checks run (fail-fast)` rather than implying the suite passed.

### D3 — terminal red gets its own exit reason

When the final attestation is red, the run exits with reason **`"done with failing checks"`** and a maintainer-facing `nextAction` (via `nextActionFor`, `next-action.ts:24`), so `otto-runs` and `otto-inspect` show it without the operator reading the report body.

The reason is phrased as a sentence to match the existing `NEXT_ACTION` keys — `"done with failures"`, `"stopped (budget)"`, `"paused (needs human)"` — rather than as a kebab-case slug, which would be the only one of its kind in the map.

**The override replaces only a success reason.** A run that stopped at `cost-cap` or `max-iterations` keeps that more-informative reason; the eval guard in D1 still sinks `succeeded`. Otherwise attestation would mask why the run actually stopped.

`"done with failing checks"` is **not** added to `SUCCESS_REASONS`. That makes D1's `terminalFailed === 0` guard redundant for overridden runs — deliberately so, and not dead code: it is the only thing that sinks `succeeded` on a terminal-red run whose exit reason was _not_ a success reason and therefore was never overridden (e.g. `"stopped (budget)"` with failing checks).

No mid-run control flow changes — escalation on attested failure is P28's job, and stays out of P27.

### D4 — disagreement is structural, not parsed

A fix commit **is** the claim that the suites are green. Disagreement is therefore defined as _an attested failure at a boundary the agent completed and committed_ — no NLP over report prose, no keyword heuristics. This keeps the disagreement signal deterministic and impossible to satisfy by accident.

## Data flow

```
boundary stage commits (reviewer | review-synth | apply-review-implementer)
  → readChecksConfig (once per run, cached)      → [] ⇒ inert, stop
  → runConfiguredChecks (in order, fail-fast)
  → ChecksRecord[] attaches to the StageRecord of the stage that moved HEAD
  → ledger.append(boundary, iteration, records)
finalize
  → resolveAttestation(ledger)
  → manifest.checksSummary + exit-reason override (success reasons only)
  → run report "Attested Checks" block, with the D4 disagreement callout
  → otto-inspect per-stage `check: PASS|FAIL <cmd> (exit N, Tms)` lines
  → eval succeeded reads terminalFailed === 0
```

In `--verify` mode, matrix rows with `method: "test"` whose `check` field (the command run — not `artifactPath`, which is a `file:line`/SHA pointer) **exactly matches** a configured check are re-executed and carry an `attestedCheck` result; non-matching rows keep today's `artifactExists` validation and are marked unattested — recorded as a coverage gap, never as a failure. Exact-match-only is deliberate: agent-emitted strings are untrusted input and must never reach a shell on a fuzzy match.

`checks`, `checksSummary`, and `attestedCheck` are harness-only fields, set by the loop and finalize — never parsed from agent JSON, mirroring `artifactExists` (`verification-matrix.ts:49-53`).

## Error handling

Fail-closed throughout:

| Condition                            | Behavior                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| No `checks` key                      | Every seam short-circuits. No records, no manifest field, no exit-reason change.                                |
| Policy-blocked command               | `exitCode: -1`, tail = the violation, **never spawned**; counts as failed and stops the ladder.                 |
| Timeout (10 min default per command) | `status: null` ⇒ `exitCode: -1`, timeout marker in the tail.                                                    |
| Spawn error                          | Same shape as timeout.                                                                                          |
| Internal attestation error           | Recorded as a failed record with the error text — never a silent green, never a thrown exception into the loop. |

Every command passes `checkCommand` (`safety-policy.ts:104`) before spawning.

**Documented out-of-contract, not solved:** check commands may leave untracked artifacts (coverage dirs, build output). Attestation runs _after_ the commit, so it cannot corrupt the diff under review, but check commands that modify **tracked** files are outside the contract and may confuse panel cleanliness assertions.

## Testing

No CI test ever spawns a real check command — the `CheckCommandRunner` seam is injected, mirroring `bench.ts`'s `CheckRunner`.

**Unit:** signature extraction (vitest `FAIL` lines, `error TS…`, duration normalization, 200-char cap, `null` when clean); tallies including `skipped`; fail-fast ordering (assert the second command was never invoked); policy-blocked-never-spawns; override-applies-only-over-success-reasons.

**Evidence:** `StageRecord.checks` / `RunManifest.checksSummary` round-trip; `otto-inspect` rendering.

**Eval fixtures:**

- **Disagreement** — exit `complete` + terminal red ⇒ `succeeded: false`.
- **Recovery** — iteration 2 red, iteration 5 green ⇒ `succeeded: true`, `everFailed: true`. This fixture exists only because of D1 and is the regression guard against reverting to an ever-failed rule.
- **Inert** — no `checks` config ⇒ manifest and report identical to the pre-P27 baseline.

## Scope and slicing

This spec covers all of P27. Implementation slices, per the roadmap:

1. `checks.ts` pure core + config contract (inert without config).
2. Policy-scoped runner + `attestation.ts` ledger.
3. **Slice 1 ships here:** the `reviewer`/`review-synth` boundary + evidence shapes + report rendering.
4. Disagreement surfacing, exit-reason override, eval signal.
5. `apply-review` boundary, then `--verify` matrix re-execution.

P28 signal wiring begins only after two boundaries are attested and stable.

## Non-goals

- **Not a second CI.** P27 runs the repo's configured checks at defined boundaries. No check discovery, no matrix builds, no flaky-test management, no retry policy.
- **No mid-run control flow.** Escalation, tier bumps, and pause-on-regression are P28.
- **No default-on behavior.** Absent `checks`, every path is inert.
- **No fuzzy command matching** anywhere agent-emitted strings meet a shell.

## Deltas from the 2026-07-10 plan

The existing implementation plan predates these decisions and disagrees in three places:

1. **`succeeded` rule.** Plan: `checksSummary.failed === 0` over a cumulative tally — marks recovered runs as failures. This spec: `terminalFailed === 0` (D1).
2. **`summarizeChecks` arity.** Plan: `summarizeChecks(records)`. This spec: `summarizeChecks(records, configuredCount)`, required to report `skipped` under fail-fast (D2).
3. **Exit reason.** Plan: report/eval only. This spec: adds the `"done with failing checks"` reason and `nextAction` (D3).

The plan is otherwise sound and should be re-anchored rather than rewritten — its `file:line` citations predate 91 changed core files (P32/otto-review), e.g. `runFixtureChecks` moved from `bench.ts:193` to `bench.ts:210`.

## Dependencies

P0 trajectory/evidence, P4 safety policy (command scoping), P15 reports, P24 verification matrix, and the `bench.ts` check-runner pattern.
