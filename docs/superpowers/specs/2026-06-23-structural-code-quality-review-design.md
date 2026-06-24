# Design: Structural code-quality review (P14)

Date: 2026-06-23
Status: Approved (brainstorm), pending spec review → implementation plan
Roadmap: [Phase 3](../../HARNESS_ROADMAP_PHASE3.md) · P14 (first build-ready slice)
Depends on (all shipped): P2 adaptive router / risk classifier (`risk.ts`), P11 per-stage model-tier routing (`model-tier.ts`), the review panel (`panel.ts`), P0 evidence bundle (`run-report.ts`), P1 eval suite.

## Summary

Otto's review panel runs four lenses — `correctness`, `security`, `tests`,
`task-fit` — and **none asks whether the change made the codebase worse**. It
also pays full price for every lens, every iteration, sequentially, with no
severity signal and no dedup. P14 closes both gaps:

- **Quality** — a new **`structural` lens** grounded in cursor's
  [thermo-nuclear-code-quality-review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md)
  seven standards, adapted to Otto's own `.claude/CLAUDE.md` conventions
  (simplicity-first, surgical changes, YAGNI). Plus a **severity model**
  (`blocker | major | minor | nit`) on every finding, so the adversarial verifier
  can downgrade and synth can suppress nits when blockers exist (cursor's output
  hierarchy), and a **finding→commit trace** so each fix is auditable.
- **Efficiency** — four levers, three of which reuse existing machinery:
  **risk-routed lens selection** (`selectLenses` already exists in `risk.ts`),
  **per-lens model-tier routing** (extend `model-tier.ts`), **cross-lens dedup**
  before verify (net-new, pure), and **parallel lenses + early-exit** (net-new in
  `panel.ts`).

Decisions locked in brainstorm: **new lens + severity-aware synth** (not a panel
rebuild, not a separate mode); **all four efficiency levers** in scope;
**opt-in/additive** — a default `--review-panel` run without the new flags keeps
today's behavior, and the legacy single reviewer is untouched.

## Grounding: what exists today

Verified against `main`:

- **Panel** — `runPanel(opts: RunPanelOptions)` in `panel.ts:123`. Lenses run
  **sequentially** (`for` loop at `panel.ts:176`), each as a stage, captured to a
  per-run tmpdir as `findings-<lens>.md`; then verify (`VERIFY_STAGE`) → synth
  (`SYNTH_STAGE`). `RunPanelOptions.lenses: string[]` (`panel.ts:79`); per-stage
  `onStage` (budget control) and `recordStage` (evidence) callbacks already exist.
  Read-only enforcement resets any lens/verify mutation when the worktree starts
  clean.
- **Lens template** — `templates/review-lens.md` is parameterized by `{{ LENS }}`;
  findings are **free-text bullets** (counted by `/^[-*]\s+\S/`), no severity, no
  fixed fields. `templates/review-verify.md` biases toward REJECTED and writes
  `verdicts.md` (`CONFIRMED|REJECTED — file:line — issue — why`).
  `templates/review-synth.md` fixes CONFIRMED only, commits one `fix(review):`.
- **Risk classifier (P2)** — `risk.ts` is pure and already does most of lever 1:
  `classifyRisk(changedPaths): RiskAssessment`, `RiskLevel = low|medium|high`,
  `ReviewDepth = single|lenses|panel`, `reviewDepthForLevel`, and
  **`selectLenses(depth, available): string[]`** (`risk.ts:137`) which already
  returns a subset of the available lens pool by depth. `routeReview` and
  `explainRouting` exist; the loop prints routing under `--explain-routing`.
- **Model tiering (P11)** — `model-tier.ts`: `ModelTier = cheap|mid|strong`,
  `routeModel({baseTier, …})`, `resolveStageModel({...})`. `Stage` already carries
  `tier?: ModelTier` (`stages.ts:8`); reviewer/verify/synth → `strong`,
  implementer/lens-tier work → `mid`. There is **no per-lens** tier seam — every
  lens resolves at the same stage tier today.
- **Evidence (P0)** — `recordStage` writes a `StageRecord` per sub-agent;
  `run-report.ts` aggregates into the run manifest.

---

## Part A — Quality: structural lens + severity model

### A1. Severity model (`review-severity.ts`, new — pure)

The spine of the whole feature: a structured finding type, a parser that reads
lens/verify output, ranking, and the nit-suppression rule. Pure functions, no
I/O — fully unit-testable.

```ts
export type Severity = "blocker" | "major" | "minor" | "nit";

export type Finding = {
  severity: Severity;
  file: string;          // e.g. "packages/core/src/loop.ts"
  line?: string;         // "31" or "31-44"; optional (whole-file findings)
  claim: string;         // one-line statement of the problem
  why: string;           // why it is real / what it costs
  suggestedFix?: string; // optional remediation hint from the lens
  lens?: string;         // which lens raised it (set on parse)
};

const ORDER: Severity[] = ["blocker", "major", "minor", "nit"];

/** Parse the structured findings block a lens or the verifier emits. Tolerant:
 *  a malformed line is dropped (not thrown) and counted in `dropped`. */
export function parseFindings(text: string, lens?: string): { findings: Finding[]; dropped: number };

/** Stable sort by severity (blocker first), preserving input order within a tier. */
export function rankFindings(findings: Finding[]): Finding[];

/** Cursor's output hierarchy: when any blocker/major exists, drop nits (and
 *  optionally minors) so the synth's attention and the report stay high-signal.
 *  Returns the kept set + a count of what was suppressed, for the trace. */
export function suppressLowValue(findings: Finding[]): { kept: Finding[]; suppressed: number };
```

**Finding wire format** (what lenses emit and the parser reads) — one finding per
block, pipe-delimited so it survives free-form prose around it:

```
SEVERITY | file:line | claim | why | fix?
```

e.g. `MAJOR | packages/core/src/loop.ts:120-180 | gate + routing + cost in one 60-line block | hard to scan, three responsibilities | extract resolveGate()`.

### A2. Structural lens guidance (`templates/lens-guidance/structural.md`, new)

The `structural` lens needs richer instruction than the other four. Rather than
bloat `review-lens.md`, add a per-lens guidance file injected via the **existing
`@include` renderer tag** (no renderer change). `review-lens.md` gains one line:

```
@include:lens-guidance/{{ LENS }}.md
```

with empty/absent guidance files for the four existing lenses (or a guarded
include) so they are unchanged. `lens-guidance/structural.md` encodes cursor's
seven standards **mapped to Otto's `.claude/CLAUDE.md`**:

| Cursor standard | Otto framing |
| --- | --- |
| Structural simplification ("code judo") | `.claude/CLAUDE.md` §2 Simplicity First — "if 200 lines could be 50, flag it" |
| File-size control (>1000 lines) | flag files crossing the bar without justification; prefer extraction |
| Spaghetti prevention | flag ad-hoc conditionals on unrelated flows; demand a dedicated abstraction |
| Design over acceptance | §3 Surgical Changes — do not rubber-stamp "it works" that leaves a mess |
| Type cleanliness | question unnecessary optionality/casts |
| Canonical layers | flag feature logic leaking into shared paths; reuse existing utilities |
| Orchestration simplicity | flag needless sequential flows where parallel is clearer |

The lens emits findings in the A1 wire format with severity. The guidance is
explicit that the lens **flags only** — it never edits (read-only contract
unchanged).

### A3. Severity-aware verify + synth

- `templates/review-verify.md` — keep the skeptic bias, but verdicts now carry
  severity and may **downgrade** (e.g. confirm-but-it's-a-nit). Verdict line:
  `CONFIRMED <severity> | file:line | claim | why-real` / `REJECTED | … | why-not`.
- `templates/review-synth.md` — parse confirmed findings (A1), `rankFindings`,
  apply `suppressLowValue`, fix in severity order, and **annotate the commit**:
  the `fix(review):` body lists the confirmed findings addressed (file:line +
  severity) and notes suppressed-nit count. Still one commit; still CONFIRMED-only;
  still no refactoring beyond the fix (preserves §3 Surgical Changes).

---

## Part B — Efficiency: four levers

### B1. Risk-routed lens selection (reuse `risk.ts`)

`selectLenses(depth, available)` already returns a lens subset by depth. Add
`structural` to the available pool and to the depth→lens mapping
(`risk.ts:137`): `single` → none, `lenses` (medium risk) → correctness + the
risk-relevant lens, `panel` (high risk) → full set incl. `structural`/`security`.
Wire `panel.ts` to run the **routed** subset (not always all of `opts.lenses`)
when the adaptive router is on, and print it under `--explain-routing`. Docs-only
or test-only changes thus skip `structural`; cross-module changes get it.

### B2. Per-lens model-tier routing (extend `model-tier.ts`)

Add a lens→`ModelTier` map and resolve each lens stage's model through the
existing `resolveStageModel` instead of a single panel tier:

```ts
export const LENS_TIER: Record<string, ModelTier> = {
  structural: "strong", security: "strong",
  correctness: "mid", "task-fit": "mid", tests: "cheap",
};
export function tierForLens(lens: string): ModelTier; // default "mid"; pin/env still wins
```

`panel.ts` resolves the per-lens model at the point it builds each lens stage.
Pin (`OTTO_MODEL`/`OTTO_CLAUDE_MODEL`) and failure-escalation precedence are
unchanged — this only sets the *base tier* per lens.

### B3. Cross-lens dedup (new, pure — in `review-severity.ts`)

Before verify, merge findings that point at the same place:

```ts
/** Merge findings by (file, overlapping line-range, normalized claim). Keeps the
 *  highest severity, unions the raising lenses, concatenates distinct why-text. */
export function dedupeFindings(findings: Finding[]): Finding[];
```

`panel.ts` reads all `findings-<lens>.md`, parses + dedupes, and writes a single
merged findings file for the verifier — so the verifier sees each issue once with
its lens provenance, not N copies.

### B4. Parallel lenses + early-exit (`panel.ts`)

- **Parallel** — replace the sequential lens `for` loop (`panel.ts:176`) with
  bounded-concurrency execution (run lenses concurrently, cap reused from the
  fan-out concurrency limit). `recordStage` ordering stays deterministic (record
  in lens-index order after the wave resolves) so evidence/tests are stable.
  `onStage` budget control still applies; a stop signal cancels not-yet-started
  lenses.
- **Early-exit** — after parse + dedupe, if **zero** findings survive, skip the
  verify and synth stages entirely and return the clean `<review>OK</review>`
  result. Today the panel always runs verify + synth.

---

## Scope guard (non-goals)

- **Not** rebuilding the panel on cursor's 7 standards (chose the additive-lens
  approach) or adding a separate `--review-thermo` mode.
- **Not** auto-refactoring beyond CONFIRMED fixes — synth never restructures
  working code for style; it fixes confirmed findings only (`.claude/CLAUDE.md`
  §3).
- **Not** the report-side severity surfacing — carrying severities into the
  user-facing report is **P15**, a separate spec. P14 stops at the
  finding→commit trace + evidence-bundle severity counts.
- **Not** touching the legacy single reviewer (`review.md`) beyond leaving it
  as-is; severity is a panel-only concept in this slice.
- **Not** a renderer change — the structural guidance rides the existing
  `@include` tag.

## File map

| File | Change |
| --- | --- |
| `packages/core/src/review-severity.ts` *(new)* | Severity type, `parseFindings`, `rankFindings`, `suppressLowValue`, `dedupeFindings` — pure |
| `packages/core/templates/lens-guidance/structural.md` *(new)* | Cursor 7-standards adapted to `.claude/CLAUDE.md`; severity wire format |
| `packages/core/templates/review-lens.md` | Emit structured severity findings; `@include:lens-guidance/{{ LENS }}.md` |
| `packages/core/templates/review-verify.md` | Severity-carrying verdicts with downgrade |
| `packages/core/templates/review-synth.md` | Rank + suppress nits + fix in severity order + annotate commit |
| `packages/core/src/risk.ts` | Add `structural` to lens pool + depth→lens mapping |
| `packages/core/src/model-tier.ts` | `LENS_TIER` map + `tierForLens` |
| `packages/core/src/panel.ts` | Routed lens subset, per-lens tier resolution, parse+dedupe merged findings, parallel execution, early-exit |
| `packages/core/src/stages.ts` | Register `structural` in default lens set |

## Implementation slices (TDD; one Otto run each)

Each slice is failing-test-first → implement → `verify: pnpm -r typecheck && pnpm -r test`.

1. **Severity model + parser** (`review-severity.ts`): `parseFindings` (incl.
   malformed-line tolerance), `rankFindings`, `suppressLowValue`. Tests pin the
   wire format and the nit-suppression rule.
2. **Cross-lens dedup**: `dedupeFindings` — merge by `(file, overlapping
   line-range, normalized claim)`, keep highest severity, union lenses. Tests
   cover overlap, no-overlap, and severity-keep.
3. **Structural lens template + guidance include**: `lens-guidance/structural.md`
   + `@include` wiring; contract test that `LENS=structural` renders the
   7-standards guidance and the four existing lenses render unchanged.
4. **Severity-aware verify + synth templates**: contract tests that verify emits
   downgradeable verdicts and synth fixes in severity order, suppresses nits when
   a blocker/major exists, and annotates the commit body with addressed findings.
5. **Risk-routed lens selection** (`risk.ts` + `panel.ts`): `structural` in the
   pool/mapping; panel runs the routed subset; decision printed under
   `--explain-routing`. Tests: docs-only skips `structural`; cross-module runs
   full set.
6. **Per-lens model-tier routing** (`model-tier.ts` + `panel.ts`): `LENS_TIER` /
   `tierForLens`; each lens stage resolves its base tier; pin/escalation
   precedence preserved. Tests: `structural→strong`, `tests→cheap`, pin wins.
7. **Parallel lenses + early-exit** (`panel.ts`): bounded-concurrency lens wave
   with deterministic record ordering; zero-findings skips verify + synth. Tests:
   ordering stable; clean change short-circuits.
8. **Finding→commit trace + evidence wiring** (`panel.ts` / `run-report.ts`):
   synth commit annotation parsed back; stage record / manifest carries severity
   counts (blocker/major/minor/nit + suppressed). Tests: trace present, counts
   recorded.

## Success metrics

- structural findings caught **and** fixed on a deliberately-bloated/spaghetti
  eval fixture (net-new finding class vs. today's four lenses).
- review cost per task ↓ (B1 risk-routing + B2 cheap-tiering + B3 dedup + B4
  early-exit) at **equal blocker-catch rate** on the eval suite.
- nit ratio in committed `fix(review):` changes ↓ (A1 suppression).
- finding→commit trace present in 100% of synth commits.
- **no regression** on P1 benchmark success/quality signals (a missed blocker
  from skipping a lens counts as a regression).
