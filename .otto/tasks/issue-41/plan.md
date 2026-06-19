# Issue #41 — Implementation plan

Bite-sized, testable tasks. Deterministic-first; the pure decision substrate
lands before any loop wiring, and all wiring is behind an off-by-default flag.
Check one off per run.

- [x] **1. Risk classifier substrate (`risk.ts`).** Pure `RiskClass` /
  `RiskLevel` / `ReviewDepth` / `RiskAssessment` types + `classifyRisk(paths)`
  (precedence: security → migration → docs/test/cross-module/narrow → unknown)
  and `reviewDepthForLevel(level)`. Inert. Pinned by `risk.test.ts`.
  Verify: `pnpm -r typecheck && pnpm -r test` green; every class/level/precedence
  case pinned.
- [x] **2. Progress signals (`progress.ts`).** Pure derivation of per-iteration
  progress from the #39 trajectory + a changed-paths/diff-stat snapshot:
  `diffChanged`, `testsDelta`, `repeatedFailureSignature`, `findingRecurrence`,
  `costBurnRate`. No I/O (callers pass snapshots). Pinned by tests.
- [x] **3. Policy (`policy.ts`).** Pure `decide(signals)` →
  `{ action: "continue" | "stop-low-progress" | "escalate-pause" |
  "finish-confident"; reason }`. Encodes early-stop / escalation thresholds.
  Pinned by tests.
- [x] **4. Route review depth by risk.** Behind `--adaptive-router` (or
  `OTTO_ADAPTIVE_ROUTER`), resolve review lenses from `classifyRisk` of the
  iteration's changed paths instead of the static list. Off by default; static
  behavior unchanged when the flag is absent. Pinned by `run-bin`/loop tests.
- [x] **5. Adaptive iteration control.** Behind the same flag, feed progress
  signals into the policy each iteration and act on the decision (early-stop,
  escalate-pause-with-report, confident-finish). Pinned by loop tests.
- [ ] **6. Benchmark entry.** Add an `adaptive-router on/off` config to the #40
  eval suite (`benchmarks/configs.json`) so the router's cost/success effect is
  measurable. Pinned by the eval CI subset.
- [ ] **7. CI deterministic tests + docs.** Wire the pure decision substrate
  into a `scripts/*.test.mjs` guard; document the router (README +
  `docs/ARCHITECTURE.md`): risk classes, routing table, progress signals,
  policies, and the off-by-default flag.

## Notes / dependencies

- Builds on #39 (`run-report.ts` trajectory) and #40 (eval suite — the router is
  A/B-tested via `adaptive-router on/off`). Both are unmerged, stacked on
  `otto/38`; this branch (`otto/41`) stacks on them.
- All routing decisions are pure functions of model-free signals, so CI can run
  the deterministic subset and the eval suite can compare router on/off
  reproducibly.
