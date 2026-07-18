# Spec — P28: Regression signals and review integrity

Source roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P28. Audit verified against
source 2026-07-10.

**Opt-in-consistent. Signals only flow when their producers exist: no `checks`
config ⇒ `failingChecks` stays `null`; no `--review-panel` ⇒
`findingSignatures` stays empty. A default run is byte-for-byte unchanged.**

## Dependency: P27 shared contract (treated as given)

P28 lands **after P27's first slice** and imports its contract from
`packages/core/src/checks.ts` (being spec'd in parallel — treat as given):

```ts
export type ChecksRecord = {
  command: string;
  exitCode: number;
  durationMs: number;
  outputTail: string;
  failureSignature: string | null;
  attestedAt: string;
};
export function summarizeChecks(records: ChecksRecord[]): {
  passed: number;
  failed: number;
  failureSignatures: string[];
};
// StageRecord.checks?: ChecksRecord[];
// RunManifest.checksSummary?: { passed: number; failed: number; failureSignatures: string[] };
```

## Problem

The adaptive control plane and the review pipeline both carry machinery that
models regression — and both are fed fiction at the wiring points:

- **The progress observation is hardcoded inert.** `IterationObservation`
  models `failingChecks`/`failureSignature`/`findingSignatures`
  (`progress.ts:11-22`), and `deriveProgress` derives `checksDelta`/
  `repeatedFailure`/`recurringFindings` from them (`progress.ts:43-75`) — but
  the loop's only call site passes `failingChecks: null, failureSignature:
null, findingSignatures: []` (`loop.ts:1544-1546`) and calls `decide` with
  `repeatedFailureStreak: 0, failingChecks: null` (`loop.ts:1553-1557`,
  `policy.ts:44`). The only live signal is the diff-stall; the
  repeated-failure escalation (`policy.ts:35,48-53`) and confident-finish
  paths can never fire.
- **Panel findings evaporate between iterations.** The merged, deduped lens
  findings (`panel.ts:317-319`, `dedupeFindings` at `review-severity.ts:108`)
  drive verify + synth and are then deleted with the panel temp dir
  (`panel.ts:423`). A finding re-raised next iteration silently re-enters the
  fix cycle — nothing flags or counts the recurrence.
- **`reviewSeverity` disagrees with the verdicts.** Severity counts are
  computed **pre-verifier** from the merged lens findings (`panel.ts:320`) and
  attached to **both** the verify and synth substage records (`panel.ts:357`,
  `panel.ts:419`), so `summarizeReviewSeverity` (`report-finalize.ts:55-76`,
  evidence line at `:168-173`) double-counts every panel iteration **and**
  counts REJECTED findings in headline totals. The verifier's verdicts —
  `CONFIRMED <severity> | … / REJECTED | …` lines in `verdicts.md`
  (`templates/review-verify.md`) — are parsed only as display-only regex
  tallies (`panel.ts:113-127`).
- **Nobody checks the synth did the work.** Synth is prompted to fix only
  CONFIRMED findings (`templates/review-synth.md`), and the harness verifies
  a commit exists (`panel.ts:399-401`) — but never that the commit addresses
  the CONFIRMED list. The "trust the verifier, trust the synth" chain is open
  at the end.
- **Dirty-worktree hole.** Lens read-only enforcement is active only when the
  worktree starts tracked-clean; otherwise the panel **warns and continues
  unenforced** (`panel.ts:232-239`), leaving `restoreIfMutated`
  (`panel.ts:247-256`) disabled exactly when a lens mutation would be most
  damaging.
- **Evidence fields half-populated.** `StageRecord.safetyEvents`/`toolsUsed`
  are declared with stale "no bin/loop populates them yet" comments
  (`run-report.ts:29-32`, `:80-84`) — in reality the render boundary and the
  compressor already populate them per stage (`stage-exec.ts:217-220`,
  threaded at `loop.ts:593-595`). What is genuinely inert: the **manifest**
  `toolsUsed` field (`run-report.ts:174`) is never aggregated, and panel
  read-only violations/refusals produce stderr lines but no `SafetyEvent`.

## Decisions (locked in brainstorming)

1. **Refuse panel mode on a dirty worktree** (uncommitted tracked changes)
   and fall back to the single reviewer with a clear warning. **No
   stash-and-restore**: stashing user state under `bypassPermissions` is
   riskier than declining. Panel is already opt-in, so this changes only
   panel-mode behavior; success bar is "restores exactly or refuses — no
   third outcome".
2. **Finding signature = `severity|file|normalized-claim`**, reusing
   `dedupeFindings`' whitespace/case normalization (`review-severity.ts:91`).
3. **Verdicts are non-authoritative for synth but best-available for
   reporting** (per `panel.ts:113-114`): record **both** raw-lens ("raised")
   and verifier-CONFIRMED counts; the report headline uses CONFIRMED, with
   REJECTED shown separately.
4. **Post-synth confirmation is a harness-orchestrated local `Stage` const**
   (the `panel.ts` LENS/VERIFY/SYNTH pattern, `panel.ts:84-98`) at `tier:
"cheap"` (`model-tier.ts:13`) — not added to `STAGES` or any chain, per
   house convention.

## Scope

**In scope:**

- **Wire the inert progress signals** (`loop.ts:1538-1579`):
  - `checkSignals(records: ChecksRecord[] | null)` (pure, in `progress.ts`)
    maps the iteration's attested `ChecksRecord`s through `summarizeChecks`
    to `{ failingChecks, failureSignature }`; no records ⇒ both `null`.
  - `findingSignatures` from the panel's merged deduped findings via a new
    `RunPanelOptions.onFindings` callback; no panel ⇒ `[]`.
  - `repeatedFailureStreak` tracked across iterations (pure
    `nextFailureStreak`: same non-null signature ⇒ increment, new ⇒ 1, none ⇒ 0) and fed to `decide` with real `failingChecks` — replacing the
    hardcoded `0`/`null` (`loop.ts:1553-1557`).
- **Cross-iteration finding memory** (`finding-memory.ts`): per-run
  signatures persisted to `.otto/runs/<run-id>/findings.json` (throws-free
  read/write, mirroring the run-bundle helpers in `run-report.ts`). A
  signature re-raised in a later iteration is flagged on stderr, counted into
  a new optional `RunManifest.findingRecurrence` (mirror the `inputSharpness`
  pattern), surfaced in the report, and fed to `decide` via a new optional
  `PolicyContext.recurringFindingCount` — recurrence ⇒ `escalate-pause`
  within one iteration of the second appearance.
- **Reconcile `reviewSeverity`**: a pure `parseVerdicts` (in
  `review-severity.ts`) parses `verdicts.md` into CONFIRMED `Finding`s (with
  the verifier's possibly-downgraded severity) + a REJECTED count. The panel
  records raw counts on the **verify** record only (fixing the double-count)
  and verdict counts on the synth record via a new optional
  `StageRecord.reviewVerdicts`; `report-finalize` headlines
  verifier-CONFIRMED totals, shows REJECTED separately, and keeps raised
  (pre-verification) counts as secondary evidence.
- **Post-synth confirmation**: a `review-confirm` local `Stage` const +
  `templates/review-confirm.md` — read-only, cheap-tier — diffs the synth
  commit against the CONFIRMED list and emits structured
  `ADDRESSED`/`UNADDRESSED` lines parsed by a pure `parseConfirmation`.
  Recorded as `StageRecord.reviewConfirmation`; unaddressed CONFIRMED
  findings are flagged in the report's What To Watch. Runs only when synth
  committed and CONFIRMED findings exist; guarded by a post-synth
  restore-if-mutated snapshot.
- **Panel read-only hardening**: `panelRefusalReason(workspaceDir)` exported
  from `panel.ts`; the loop checks it before invoking the panel and falls
  back to the single reviewer with a warning + a run-level `SafetyEvent`;
  `runPanel` itself hard-refuses (synthetic non-error result) as
  defense-in-depth, deleting the warn-and-continue branch. Read-only
  violations that `restoreIfMutated` undoes now emit a blocked
  `policy-violation` `SafetyEvent` onto the substage record.
- **Evidence completion**: aggregate per-stage `ToolUsage` into the manifest
  `toolsUsed` (mirror `runSkillsUsed`, `loop.ts:615/888`); correct the stale
  INERT comments in `run-report.ts`.
- Docs: `README.md` (review panel section), roadmap §P28 status note.

**Out of scope:**

- P27's checks runner, config, and attestation points themselves — P28 only
  consumes `ChecksRecord`s the loop already captured.
- Harness auto-fixing unaddressed CONFIRMED findings (confirmation flags;
  humans or the next iteration act).
- Stash-and-restore of user worktree state (rejected — Decision 1).
- Changing `decide`'s existing thresholds (`REPEATED_FAILURE_LIMIT`,
  `STALL_LIMIT`) or any behavior of non-panel, non-adaptive, non-checks runs.
- Recorded-run A/B eval configs for regression signals (pure vitest fixtures
  prove the mechanics this slice).

No new npm dependencies. ESM `.js` relative imports preserved (NodeNext).

## Testable success criteria

1. `checkSignals` returns `null`s with no records, `failingChecks: 0` on
   all-pass, and the failed count + dominant signature on failures;
   `nextFailureStreak` increments only on a repeated non-null signature.
2. A recurring-defect fixture (same finding signature raised in iterations 1
   and 2) drives `decide` to `escalate-pause` **within one iteration of the
   second appearance**; `findings.json` carries both iterations and the
   manifest's `findingRecurrence` lists the recurring entry.
3. `parseVerdicts` yields CONFIRMED findings with the verifier's severity
   (downgrades honored), counts REJECTED lines, handles `none`, and drops
   malformed lines counted.
4. On a fixture panel run, report headline severity totals equal the
   verifier-CONFIRMED counts; REJECTED appear separately; raw raised counts
   are recorded once (verify record only — no double count).
5. Post-synth confirmation catches a synthetic "synth skipped a CONFIRMED
   finding" fixture: `parseConfirmation` surfaces the unaddressed finding and
   the finalized report flags it in What To Watch.
6. Panel mode on a dirty tracked worktree refuses (no lens spawns, synthetic
   result, single-reviewer fallback in the loop) — and on a clean worktree a
   mutating sub-agent is restored exactly with a recorded `SafetyEvent`. No
   third outcome.
7. A run with stage-level `toolsUsed` aggregates them onto the manifest;
   default runs (no checks config, no panel) produce byte-identical
   observations and reports to today.

## Non-goals / risks

- **Do not let regex verdict counts drive fixes.** Synth remains the
  authority on what it fixes (`panel.ts:113-114`); `parseVerdicts` feeds
  **reporting and confirmation**, never the fix cycle.
- **Do not escalate on noise.** Recurrence keys on the deduped signature
  (severity|file|normalized claim); a reworded-but-same claim may evade — the
  signature errs toward false negatives, never false escalation.
- **Do not touch user state.** The dirty-worktree path refuses; `reset
--hard` still runs only from a tracked-clean baseline.
- **Keep every consumer null-safe.** Absent checks config, absent panel,
  absent verdicts ⇒ every new field stays absent/null and every summary
  degrades to today's text.

## Task outline (detailed in the plan)

1. `checkSignals` + `nextFailureStreak` in `progress.ts` (+ tests).
2. `findingSignature` + per-run finding memory (`finding-memory.ts`) (+ tests).
3. `PolicyContext.recurringFindingCount` escalation rule in `policy.ts` (+ tests).
4. `parseVerdicts` + `StageRecord.reviewVerdicts` + panel verdict recording
   (verify-only raw counts) (+ tests).
5. Report reconciliation: CONFIRMED headline, REJECTED separate, raised
   secondary (`report-finalize.ts`) (+ tests).
6. Post-synth confirmation substage: template + `parseConfirmation` + panel
   wiring + report flag (+ tests).
7. Dirty-worktree refusal + single-reviewer fallback + read-only-violation
   `SafetyEvent`s (+ tests).
8. Loop wiring (observations, streaks, memory persistence, manifest
   recurrence + `toolsUsed` aggregation), recurring-defect trajectory fixture
   test, stale-comment fixes, docs.
