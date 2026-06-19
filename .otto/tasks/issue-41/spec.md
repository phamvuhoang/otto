# Issue #41 — P2: Adaptive compute router

Part of the Otto Harness Enhancement Roadmap · Epic #38 · Priority P2 (Large).

## Problem

Otto spends a **fixed** compute budget per run: `N` iterations, each followed by
the same review chain (single reviewer, or the full panel when `--review-panel`
is set). A one-line docs fix pays the same review tax as a cross-module security
change, and a run that has stopped making progress keeps burning iterations
until `N` is exhausted. Compute is allocated by configuration, not by evidence.

The issue asks Otto to move toward **evidence-driven compute allocation**: route
review depth by task risk, watch progress signals across iterations, and
stop/escalate early when the signals justify it — so success-per-dollar improves
and long AFK runs churn less.

## Approach

Build the router bottom-up, deterministic-first, mirroring how P0 (#39) and P1
(#40) landed — a pure, tested, **inert** decision substrate first, then wiring
behind an off-by-default flag, then a benchmark + docs. Every routing decision
must be a pure function of signals Otto can derive without a model call, so the
behavior is reproducible and unit-testable, and so the eval suite (#40) can
A/B `adaptive-router on/off` deterministically.

The router has three pure decision surfaces:

1. **Risk classification** — classify the change into a risk *class* and *level*
   from the set of changed file paths, then route review *depth* by level.
2. **Progress signals** — derive per-iteration progress from the run trajectory
   (#39 bundle) + git diff: did the diff change, are tests trending green,
   is a failure signature repeating, are reviewer findings recurring, what is
   the cost burn rate.
3. **Policy** — given the progress signals, decide whether to continue, stop on
   low marginal progress, escalate/pause for a human, or short-circuit to a
   confident finish.

This spec starts with surface #1 (risk classification + review-depth routing),
the smallest pure foundation the rest composes on.

### First slice (this run's task)

A pure module `packages/core/src/risk.ts`:

- `RiskClass` — `"docs-only" | "test-only" | "narrow-code" | "cross-module" |
  "security-sensitive" | "migration-release" | "unknown"`.
- `RiskLevel` — `"low" | "medium" | "high"`.
- `ReviewDepth` — `"single" | "lenses" | "panel"`.
- `RiskAssessment` — `{ class: RiskClass; level: RiskLevel; reasons: string[] }`.
- `classifyRisk(changedPaths: string[]): RiskAssessment` — deterministic
  classification from the changed-file path set. No I/O, no model calls.
- `reviewDepthForLevel(level: RiskLevel): ReviewDepth` — the routing table
  (low → single, medium → lenses, high → panel).

Kept **inert** (not imported by any bin/loop) — like `task-key.ts`, the initial
`run-report.ts`, and `eval.ts` — so adding it cannot regress existing runs. The
loop wiring is a later plan task, behind a flag.

### Classification rules (deterministic, highest-risk-class wins)

`classifyRisk` inspects the path set in precedence order; the first class that
matches wins, and `reasons` records why:

1. **security-sensitive** (level `high`) — any path matching
   `auth|credential|secret|token|crypto|sandbox|permission|security` (case-
   insensitive). Security review must never be downgraded by a co-changed doc.
2. **migration-release** (level `high`) — any path that is a migration or
   release artifact: `migrations/`, `*.sql`, `release-please`, `CHANGELOG`,
   a `package.json`, or a lockfile.
3. Otherwise classify by file nature:
   - all paths are docs (`*.md` or under `docs/`) → **docs-only** (`low`).
   - all paths are tests (`*.test.*`, `*.spec.*`, under `__tests__/` or
     `test/`) → **test-only** (`low`).
   - code paths spanning **≥2 distinct top-level segments** → **cross-module**
     (`high`).
   - otherwise → **narrow-code** (`medium`).
4. **unknown** (level `high`) — empty path set. When Otto cannot see what
   changed, it routes conservatively (more verification, not less).

`reviewDepthForLevel`: `low → single`, `medium → lenses`, `high → panel`.

## Assumptions (question → answer → rationale)

- **How much of #41 this run?** → Only the pure `classifyRisk` +
  `reviewDepthForLevel` substrate. Rationale: #41 is Large; the repo's
  established pattern is substrate-first, and risk classification is the
  foundation review-routing and policy compose on. One TDD task per the AFK
  protocol.
- **Classify from paths, not diff content?** → Paths only, this slice. Rationale:
  paths are cheap, deterministic, and available before any model call; diff-stat
  and content signals belong to the progress-signals task. YAGNI.
- **Where does "unknown" route?** → `high`. Rationale: conservative — absence of
  evidence is not evidence of low risk; matches the issue's "verify when
  uncertain" intent.
- **Wire it in now?** → No. Inert until a later task routes review depth behind
  an off-by-default `--adaptive-router` flag. Rationale: cannot regress existing
  behavior; mirrors `eval.ts`.
- **Why does security/migration outrank cross-module?** → A security- or
  release-sensitive path makes the whole change high-risk regardless of breadth,
  so it is checked first and cannot be masked by a narrow edit.

## Testing notes

Pin with `packages/core/src/__tests__/risk.test.ts` (vitest), pure path-array
inputs (no fs):

- docs-only / test-only → low → single.
- a single code file in one module → narrow-code → medium → lenses.
- code touching ≥2 top-level segments → cross-module → high → panel.
- any auth/secret/sandbox path → security-sensitive → high, even mixed with docs.
- a migration/release/lockfile/package.json path → migration-release → high.
- empty paths → unknown → high.
- precedence: security beats migration beats cross-module beats narrow.
- `reasons` names the triggering path(s).
- `reviewDepthForLevel` maps every level.

Feedback loops: `pnpm -r typecheck && pnpm -r test`.
