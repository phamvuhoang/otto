# Design: P28 — regression signals and review integrity

Date: 2026-07-30
Status: Approved (brainstorm, decisions made on the operator's behalf — see [Decisions](#decisions)), pending spec review → plan refresh
Applies to: the adaptive router's progress/policy path, the review panel, and report severity reconciliation.
Tracking: issue #248 (epic #245). Roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P28.
Depends on: **P27 implementation** (spec merged as `a3cd6e2`; no code yet — see [Dependencies](#dependencies)).

## Problem

The control plane models signals it never receives.

- **`loop.ts:1884-1886` hardcodes `failingChecks: null`, `failureSignature: null`, `findingSignatures: []`** into every `IterationObservation`, and `:1893-1897` hardcodes `repeatedFailureStreak: 0`, `failingChecks: null` into every `PolicyContext`. `deriveProgress` (`progress.ts:43`) and `decide` (`policy.ts:44`) fully model these, so adaptive iteration control is a **stall detector wearing a regression detector's clothes**.
- **Escalation cannot fire.** `REPEATED_FAILURE_LIMIT = 3` is compared against a streak that is always `0`; `recurringFindings` is derived from an always-empty list.
- **Report severity totals disagree with verifier verdicts.** `summarizeReviewSeverity` (`report-finalize.ts:56`) sums `reviewSeverity` across **every** stage record that carries one. `panel.ts:177` passes it for **both** the verify and synth substages, so a panel run double-counts, and REJECTED findings inflate the headline.
- **Panel read-only enforcement is conditional.** `panel.ts:438` only arms lens mutation detection when `baseHead != null && trackedStatus(workspaceDir) === ""` — a dirty worktree silently disables the guard.
- **`toolsUsed` / `safetyEvents` are declared and inert** (`run-report.ts:160-162`, `:246-248`).

## Outcome

Adaptive iteration control reacts to attested check failures and recurring findings; the review pipeline's bookkeeping stops disagreeing with itself. Runs without `--adaptive-router` and without a `checks` config are unchanged.

## Decisions

The operator was remote. Each decision states its rationale so it can be reversed cheaply.

### D1 — `finish-confident` stays dormant. This is the headline decision.

**Wiring `PolicyContext.failingChecks` naively would arm a latent run-ending bug.**

`policy.ts:55-59` returns `finish-confident` whenever `ctx.failingChecks === 0`, and its own comment (`:58`) says it will "short-circuit to a confident finish/verify". It does not. `loop.ts:1909-1918` maps it to:

```ts
const reason =
  decision.action === "stop-low-progress"
    ? "stopped (low progress)"
    : decision.action === "escalate-pause"
      ? "paused (needs human)"
      : "complete";
summarize(reason, i);
clearState(workspaceDir);
return outcome();
```

It **terminates the run** with exit reason `"complete"` — no verify stage, no gate consultation. Because `failingChecks` is hardcoded `null` today, `ctx.failingChecks === 0` has **never once been true**, so this branch has never executed in production.

The moment P28 supplies a real count, the first iteration whose reviewer commits and whose checks pass ends the entire run and reports success — abandoning every remaining backlog task. `"complete"` is in `SUCCESS_REASONS` (`eval.ts:78`), so eval scores it as a win, and P27's exit-reason override does not fire (terminal checks were green). A run that silently skipped 40 open issues would be indistinguishable from one that finished them.

**Therefore P28 wires the escalation signals and deliberately leaves `PolicyContext.failingChecks` as `null`.** Escalation can only ever stop a run that is going badly, which is exactly the roadmap's stated outcome ("repeated-failure loops and re-fixed defects are detected"). Short-circuiting a run that is going _well_ is a different feature with a different risk profile, and its current implementation is wrong.

A regression test must pin this: with green attested checks wired end-to-end, `decide` must return `continue`, not `finish-confident`.

Fixing `finish-confident` — making it route to the verifier stage, or requiring gate agreement that no tasks remain — is out of P28's scope and should be tracked separately. The sentinel (`<promise>NO MORE TASKS</promise>`) already ends runs correctly, so the confident-finish path may simply be redundant.

### D2 — per-iteration signals come from the ledger, never from `checksSummary`

P27 produces two shapes: per-boundary `AttestationLedger` entries (each carrying `boundary`, `iteration`, `configuredCount`, `records`) and the run-level `ChecksSummary`.

`ChecksSummary` is **terminal and cumulative by design** (P27 D1): `terminalFailed` describes the last attestation and `passed`/`failed` accumulate across the whole run. Feeding either into a per-iteration observation would be wrong — cumulative counts never decrease, so `checksDelta` would report improvement that did not happen, and terminal state describes the end of the run rather than this iteration.

P28 therefore reads **the ledger entries whose `iteration` matches the current one**, and derives `failingChecks` / `failureSignature` from those records alone. This integration only works because P27 kept per-boundary records instead of collapsing to a tally.

### D3 — a recurring finding escalates on its second appearance and outranks green checks

`signals.recurringFindings` is non-empty exactly when a signature appears in both this and the prior iteration — i.e. its **second appearance**, which is what the roadmap's success metric asks for ("escalated within one iteration of its second appearance"). No change to `REPEATED_FAILURE_LIMIT = 3` is needed; that governs repeated _check_ failures, a different signal.

The new rule is evaluated with escalate precedence, immediately after `repeatedFailureStreak` and **before** the `finish-confident` branch: a fixed defect coming back is not cleared by a green suite. (Under D1 that branch is unreachable anyway, but precedence is stated so the ordering stays correct if D1 is ever reversed.)

### D4 — severity headlines count verifier-CONFIRMED findings only, and stop double-counting

Two defects, one fix site (`report-finalize.ts:56`):

1. `reviewSeverity` is recorded for **both** the verify and synth substages, so summing across all stage records counts the same findings twice.
2. REJECTED findings are included in the headline.

The summary must therefore be derived from the **verifier's** record only, restricted to CONFIRMED verdicts, with REJECTED reported separately rather than folded into the totals.

### D5 — a dirty worktree refuses panel mode

`panel.ts:438` disarms lens mutation detection on a dirty worktree, which is the one situation where a lens writing to the tree is hardest to detect and most damaging. Stash-and-restore was considered and rejected: stashing under an unattended agent that may itself run git commands risks losing operator work, and a failed restore is unrecoverable.

Panel mode on a tracked-dirty worktree **refuses to run** with an actionable message. No third outcome, per the roadmap's success metric.

### D6 — populate `toolsUsed` / `safetyEvents` at their existing production points

Both fields already exist on `StageRecord` and `RunManifest` and both already have producers elsewhere in the codebase (tool adapters emit `ToolUsage`; the safety policy emits `SafetyEvent`). This is plumbing to the natural call sites, not new instrumentation.

## Architecture

- **`progress.ts`** gains `checkSignals(records)` (records → `{ failingChecks, failureSignature }`; absent/empty ⇒ `null`/`null`, preserving today's unmeasured semantics) and `nextFailureStreak(prev, cur, prevStreak)`.
- **`findings.ts` (or `panel.ts`)** gains a stable finding-signature derivation plus per-run persistence so a signature raised in iteration N is comparable in N+1.
- **`policy.ts`** gains `PolicyContext.recurringFindingCount?: number` (optional; absent ⇒ 0 ⇒ today's behavior at every existing call site) and the D3 rule.
- **`loop.ts`** replaces the hardcoded literals at `:1884-1886` and `:1893-1897` — supplying real `failingChecks`/`failureSignature`/`findingSignatures` and `repeatedFailureStreak`/`recurringFindingCount`, while holding `PolicyContext.failingChecks` at `null` per D1.
- **`report-finalize.ts`** reconciles severity per D4.
- **`panel.ts`** refuses on a dirty worktree per D5 and gains the post-synth confirmation pass.

## Data flow

```
iteration N ends
  → attestation ledger entries where iteration === N        (P27, D2)
  → checkSignals(records) → { failingChecks, failureSignature }
  → finding signatures from the verifier's CONFIRMED verdicts
  → IterationObservation { diffSignature, failingChecks,
                           failureSignature, findingSignatures, cost }
  → deriveProgress(cur, prev) → { diffChanged, checksDelta,
                                  repeatedFailure, recurringFindings, burn }
  → decide(signals, { stalledIterations,
                      repeatedFailureStreak,
                      recurringFindingCount,
                      failingChecks: null })                (D1)
  → continue | stop-low-progress | escalate-pause
```

Note a safe side effect of wiring `IterationObservation.failingChecks`: `checksDelta` becomes non-null, so `notImproving` (`policy.ts:62`) is false while failures are dropping. `stop-low-progress` therefore becomes **less** aggressive than today, never more.

## Error handling

| Condition                              | Behavior                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No `checks` config                     | `checkSignals` ⇒ `null`/`null`. Every derived signal matches today's unmeasured behavior.         |
| No `--adaptive-router`                 | The whole path is skipped, as today.                                                              |
| Verifier emitted no parseable verdicts | No finding signatures; recurring-finding escalation cannot fire. Never inferred from lens output. |
| Finding-signature store unreadable     | Treated as empty (no recurrence detected) — never throws into the loop.                           |
| Tracked-dirty worktree + panel mode    | Refuse with an actionable message (D5).                                                           |

## Success metrics

- A fixture with a recurring injected defect escalates (pause or tier bump) within one iteration of its second appearance.
- Report severity totals match verifier verdicts on every panel run; REJECTED appears separately.
- Post-synth confirmation catches a synthetic "synth skipped a CONFIRMED finding" fixture.
- Panel mode on a dirty worktree either restores it exactly or refuses; no third outcome.
- **Green attested checks do not end a run early** — the D1 regression test.
- Runs without `--adaptive-router` or without `checks` are byte-for-byte unchanged.

## Non-goals

- **No `finish-confident` redesign** (D1). Dormant, pinned by test, tracked separately.
- **No stash-and-restore** (D5).
- **No new severity taxonomy** — D4 reconciles counting, not classification.
- **No mid-run tier escalation beyond what the router already supports.**

## Dependencies

**P27 must be implemented first**, not merely specced. Its design spec merged as `a3cd6e2`, but `packages/core/src/checks.ts` and `attestation.ts` do not exist yet. P28 Task 1 imports `ChecksRecord` and reads `AttestationLedger` entries; it cannot compile before P27 ships.

Per the roadmap's own sequencing, P28's signal wiring begins only after **two** P27 attestation boundaries are attested and stable.

Also depends on P14 review panel, `progress.ts`/`policy.ts` substrate, and the review-severity and report-finalize pipelines.

## Deltas from the 2026-07-10 plan

1. **D1 is new and is a blocker.** The prior plan wires `PolicyContext.failingChecks` from `checkSignals` without noting that doing so arms the run-ending `finish-confident` branch for the first time. Its Task 3 reasons about `finish-confident` only in the narrow case of recurring-finding precedence.
2. **D2 is new.** The prior plan predates P27's terminal-vs-cumulative split, so it does not say which P27 shape feeds per-iteration signals. Reading `ChecksSummary` would corrupt `checksDelta`.
3. **`summarizeChecks` arity changed** in P27's merged spec to `(records, configuredCount)`. The prior plan's Task 1 cites the old `(records)` signature.
4. **D4 now also covers the verify/synth double-count**, not only REJECTED inflation.
