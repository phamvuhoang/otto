# Design: Model & sub-agent orchestration (P11)

Date: 2026-06-20
Status: Approved (brainstorm), pending spec review → implementation plan
Issue: #66 (P11) · Epic: #68 (Phase 2)
Depends on (all shipped): P2 adaptive router (#41), P7 context efficiency (#62), P8 spec & plan authoring (#63), P1 eval suite, the agent-runtime abstraction.

## Summary

Two subsystems under one spec, sequenced as two phases that can land independently:

- **Part A — Per-stage model-tier routing** (Phase 1, slices 1–3): today the model is chosen per _run_ (`OTTO_MODEL` / `OTTO_CLAUDE_MODEL`). Make it per _stage_: declare each stage's difficulty tier, resolve tiers to concrete models via a config-overridable ladder, and let the existing adaptive router (P2) modulate the tier by change-risk and escalate it on repeated failure. Cheap model for mechanical/codegen, strong model for design/review. Small, low-risk, immediate cost win.
- **Part B — Sub-agent fan-out** (Phase 2, slices 4–8, opt-in): run the independent tasks of a P8 plan as isolated sub-agents in their own git worktrees, in parallel waves, then merge their commits back with a hard safety fallback to today's sequential loop. New `tasks.json` plan artifact, `worktree.ts`, `fanout.ts`, a `subImplementer` stage.
- **Part C — Eval-driven policy** (woven through both): config overlays in the P1 eval suite so the routing/fan-out defaults are tuned against cost/wall-clock/success signals, not intuition.

Decisions locked in brainstorm: **named tiers, config-mapped** (not raw model IDs, not a difficulty score); **plan declares parallel groups + git worktrees + synthesizer merge** (the most robust fan-out path); **both subsystems in one spec**, sequenced; **opt-in** everywhere (default run is byte-for-byte today's behavior). Claude-first: Codex-runtime tier routing is a non-goal for v1.

## Grounding: what exists today

From the codebase map (verified against `main`):

- **Model selection** — `resolveModelSelection(runtimeId, env)` in `runner.ts` returns `{spec, source}` or `undefined`; precedence `OTTO_${RUNTIME}_MODEL → OTTO_MODEL → undefined`. Threaded once per stage at `runStage` via `buildArgs(stage, promptRelPath, resolveModelArgs(resolveModelSelection(runtime.id)?.spec), settingsPath)`. There is **no per-stage** seam — every stage gets the same model.
- **Router** — `routeReview(changedPaths, available): RouteDecision` in `risk.ts` is pure and deterministic; it classifies change risk (`RiskAssessment { class, level, reasons }`) and picks a review `depth`. Invoked in `loop.ts` only for the reviewer stage. `decide(signals, ctx): PolicyDecision` in `policy.ts` already detects `REPEATED_FAILURE_LIMIT = 3` and returns an escalate decision — **currently inert** (the loop does not act on it).
- **Stage** — `type Stage = { name; template; permissionMode? }` in `stages.ts`; `STAGES` registry; chains assembled in `main.ts` / `gh-main.ts`. `executeStage` (`stage-exec.ts`) is the single render-inside-retry + `runStage` entry used by both `loop.ts` and `panel.ts`.
- **Plan (P8)** — plan stage persists `spec.md` + `plan.md` under `.otto/tasks/<task-key>/` (`deriveTaskKey` in `task-key.ts`). The task list is GitHub-style checkboxes parsed by `parsePlanProgress` into `PlanProgress.items[] { text, done }` — **text only**, no file-scope or dependency metadata.
- **Fan-out precedent** — `runPanel` (`panel.ts`) runs lenses **sequentially**, captures each to disk, then verify → synth. Genuine concurrency is net-new.
- **Eval (P1)** — `BenchmarkTask` + `EvalConfig { label, args, env }` overlays replayed per task; `scoreTrajectory(manifest, stages)` is pure → `EvalSignals` (includes `costUsd`, `totalTokens`, `elapsedMs`, `succeeded`).
- **Flags** — `parseFlags(argv)` → `CliFlags`; resolved + threaded in `runBin` with `--flag → OTTO_ENV → .otto/config.json → default` precedence (the `--adaptive-router` pattern is the template to copy).

---

## Part A — Per-stage model-tier routing

### A1. Tier ladder (`model-tier.ts`, new)

```ts
export type ModelTier = "cheap" | "mid" | "strong";

// tier → concrete model spec passed to the runtime's --model (undefined = runtime default)
export type TierLadder = Record<ModelTier, string | undefined>;

export const DEFAULT_LADDER: TierLadder = { cheap: "haiku", mid: "sonnet", strong: "opus" };

export function resolveTierLadder(env = process.env): TierLadder;
```

`resolveTierLadder` overlays `OTTO_TIER_CHEAP` / `OTTO_TIER_MID` / `OTTO_TIER_STRONG` onto `DEFAULT_LADDER` (a blank/unset value falls through to the default). Values are CLI aliases or full model IDs — Otto does not validate them; the runtime does. The ladder is provider-agnostic in shape, but defaults are Claude aliases; Codex keeps `OTTO_CODEX_MODEL` (non-goal to tier-route Codex in v1).

### A2. Stage → tier declaration

Extend `Stage`:

```ts
export type Stage = { name: string; template: string; permissionMode?: string; tier?: ModelTier };
```

Default tiers in `STAGES`: `plan`, `reviewer`, `verify`, `applyReview`/synth → `strong`; `implementer`, `ghafkImplementer`, review `lens` → `mid`. No stage defaults to `cheap` — `cheap` is reachable only via risk-downgrade (A3). A stage with no `tier` resolves to the runtime default (today's behavior), so the field is additive.

### A3. Routing function (`routeModel`, pure — sibling to `routeReview` in `risk.ts`)

```ts
export function routeModel(opts: {
  baseTier: ModelTier;            // stage.tier ?? "mid"
  assessment?: RiskAssessment;    // reuse routeReview's classification (reviewer/implementer only)
  escalations?: number;           // count of prior repeated-failure escalations this run
}): { tier: ModelTier; reasons: string[] };
```

Rules (deterministic, unit-tested as a table):

- Start at `baseTier`.
- **Risk down**: `docs-only` or `test-only` change → drop one tier (`mid → cheap`), floor at `cheap`.
- **Risk up**: `security-sensitive` or `cross-module` change → raise to `strong`.
- **Escalation up**: `escalations` ≥ 1 → raise one tier (`cheap→mid→strong`), capped at `strong`. This is what finally consumes `decide()`'s repeated-failure signal.
- Tier ordering is `cheap < mid < strong`; all bumps clamp to `[cheap, strong]`.

`routeModel` does **not** know about models — only tiers. The ladder turns the tier into a spec at the call site.

### A4. Threading the per-stage model

`resolveModelSelection` stays as the global override check. Add a stage-aware resolver used by `runStage`:

```ts
// returns the model spec for this stage, or undefined for runtime default
resolveStageModel(opts: {
  runtimeId; stage; routing: boolean; ladder: TierLadder;
  assessment?: RiskAssessment; escalations?: number; env;
}): { spec: string | undefined; tier?: ModelTier; source: string };
```

**Precedence (back-compat is the invariant):**

1. Explicit global pin — `OTTO_${RUNTIME}_MODEL` / `OTTO_MODEL` / `--model` — wins and **disables routing** (source `"pin"`). A user who pinned a model keeps it on every stage.
2. Routing on (`--model-routing`) and stage has a tier → `ladder[routeModel(...).tier]` (source `"route"`).
3. Otherwise `undefined` → runtime default (source `"default"`).

`runStage` (and `runPanel`, for lenses) receive the route inputs and call `resolveStageModel`, then `buildArgs(..., resolveModelArgs(spec), ...)`. The chosen `{tier, spec, source}` is recorded on the stage record (new optional fields) so it lands in the trajectory/bundle and `--explain-routing` can print it.

### A5. Activation & surface

- `--model-routing` flag + `OTTO_MODEL_ROUTING` (mirrors `--adaptive-router` resolution exactly). Off by default.
- `--explain-routing` (exists) extended: when routing is on, print one line per stage — `route: implementer → mid (sonnet) [base mid]` or `… → strong (opus) [escalated ×1]`.
- `--print-config` shows `modelRouting`, the resolved ladder, and per-stage base tiers.
- Reuse of risk: the loop already computes `routeReview`'s `RiskAssessment` for the reviewer when `--adaptive-router` is on; reuse that same assessment for `routeModel`. When `--model-routing` is on without `--adaptive-router`, compute the assessment from the same `changedPaths` (cheap, pure) so model routing is usable standalone.

---

## Part B — Sub-agent fan-out (opt-in, Phase 2)

### B1. Machine-readable task graph (upgrades P8)

The plan stage emits, in addition to `plan.md`, a `.otto/tasks/<task-key>/tasks.json`:

```jsonc
{
  "version": 1,
  "tasks": [
    { "id": "t1", "title": "Add tier ladder", "fileScope": ["packages/core/src/model-tier.ts"], "dependsOn": [], "parallelSafe": true },
    { "id": "t2", "title": "Wire routing into runStage", "fileScope": ["packages/core/src/runner.ts"], "dependsOn": ["t1"], "parallelSafe": false }
  ]
}
```

- `plan.md` template gains a section instructing the planner to also write `tasks.json` with these fields, with `fileScope` listing the files each task is expected to touch and `parallelSafe` false for anything risky.
- New `plan-tasks.ts`: `parsePlanTasks(json): PlanTask[]` validates the schema (ids unique, deps resolve, no cycles). **Invalid or missing → fan-out is silently disabled** and the normal loop runs. Graceful degradation is mandatory; a bad `tasks.json` never aborts a run.
- Pure `planParallelGroups(tasks): PlanTask[][]` → topologically sorts into **waves**. A task joins the current wave only if its `dependsOn` are all in earlier waves, it is `parallelSafe`, and its `fileScope` is **disjoint** from every other task already in that wave. Non-`parallelSafe` tasks (or any whose scope overlaps) become singleton waves — i.e. they run alone, preserving correctness.

### B2. Worktree isolation primitive (`worktree.ts`, new)

```ts
createWorktree(workspaceDir, id): Promise<{ dir: string; cleanup(): Promise<void> }>;
```

- `git worktree add --detach <workspaceDir>/.otto-tmp/wt/<id> HEAD`. The dir is **inside `workspaceDir`**, so the native OS sandbox still confines writes (no sandbox change needed). `.otto-tmp/` is already gitignored.
- `cleanup()` runs `git worktree remove --force` and is invoked in `finally`, like spill dirs. A reaper on fan-out entry prunes any orphaned `.otto-tmp/wt/*` from a crashed prior run.
- Sub-agents `cwd` into the worktree and commit there on the detached HEAD.

### B3. Fan-out executor (`fanout.ts`, modeled on `panel.ts` but concurrent)

```ts
runFanout(opts: {
  tasks: PlanTask[]; workspaceDir; packageDir; iteration;
  maxRetries; cooldownMs; concurrency; signal?;
  ladder; routing; runtimeId;
  onStage?; recordStage?;
}): Promise<FanoutResult>;
```

- For each wave (`planParallelGroups`): run its tasks concurrently, capped at `concurrency` (default 3, `--fan-out-concurrency`). Each task = one `subImplementer` stage via `executeStage`, with `cwd` = its worktree and a **bounded context**: the task `title`, its `fileScope` files, and learnings — *not* the whole plan (reinforces P7's context-isolation goal). Each sub-agent makes its own commit(s) in its worktree.
- Costs roll into the run total through `onStage`/`recordStage` exactly like panel sub-stages; budget/cooldown are the loop's. Concurrency uses a small bounded pool (no new dependency) and is abortable via `signal`.

### B4. Synthesizer + safety fallback

After each wave, the executor merges sequentially onto the main workspace HEAD:

- For each finished task, `git cherry-pick` its worktree commit(s) onto the workspace branch.
  - **Clean** → keep.
  - **Conflict** (`git cherry-pick --abort`) or a post-wave **verify failure** (run the configured verify command once after the wave merges) → the task is marked `deferred` and **re-queued to run sequentially in the normal implementer loop**.
- The **core safety guarantee**: fan-out never leaves the tree in a conflicted or half-merged state. Worst case (every task conflicts) it degrades to exactly today's sequential behavior, just having spent some parallel effort first. Deferred tasks are handed back to `runLoop` as ordinary implementer work.
- A short synth note (which tasks landed via fan-out, which deferred and why) is recorded for the run report (P9) and the live view (P10).

### B5. Activation & surface

- `--fan-out` flag + `OTTO_FAN_OUT`; `--fan-out-concurrency <n>` (default 3, int ≥ 1). Off by default.
- Requires a valid `tasks.json` → in practice requires `--plan` to have produced one. Without it: warn once, run normally.
- `--print-config` shows `fanOut`, `fanOutConcurrency`.

---

## Part C — Eval-driven policy

Add `EvalConfig` overlays so defaults are tuned, not asserted:

- `{ label: "model-routing", args: ["--model-routing"] }`
- `{ label: "fan-out", args: ["--plan", "--fan-out"] }`
- Baseline (no args) for comparison.

`scoreTrajectory` already yields `costUsd`, `totalTokens`, `elapsedMs`, `succeeded` per config; the eval table compares them directly against the issue's success metrics (cost/task ↓ at equal success; wall-clock ↓ on parallelizable plans; escalation rate sane). No auto-tuning loop — the table informs the committed defaults.

## New surface (summary)

| Flag / env                          | Effect                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `--model-routing` / `OTTO_MODEL_ROUTING` | Route each stage to a model tier by stage + risk + escalation.            |
| `OTTO_TIER_CHEAP/MID/STRONG`        | Override the tier → model ladder (default `haiku`/`sonnet`/`opus`).            |
| `--fan-out` / `OTTO_FAN_OUT`        | Run independent plan tasks as isolated worktree sub-agents (needs `tasks.json`). |
| `--fan-out-concurrency <n>`         | Max concurrent sub-agents per wave (default 3).                               |
| `--explain-routing` (extended)      | Also print the per-stage tier/model decision.                                 |

A pinned `--model`/`OTTO_MODEL` disables tier routing (precedence rule A4.1).

## Sequencing (8 slices, one spec)

**Phase 1 — model-tier routing (mergeable on its own):**

1. `model-tier.ts` (ladder + `resolveTierLadder`) + `Stage.tier` + default tiers + `resolveStageModel` threading into `runStage` (static tiers, no router yet). Verify: each stage spawns with the expected `--model`.
2. `routeModel` (risk modulation) + `--model-routing` activation + precedence + stage-record telemetry + `--explain-routing`/`--print-config`. Verify: routing table unit tests; pinned model wins.
3. Escalation tier-bump: feed `decide()`'s repeated-failure count into `routeModel`. Verify: unit test (N failures → tier rises, capped).

**Phase 2 — fan-out (separable; depends on Phase 1's ladder for sub-agent model choice):**

4. `tasks.json` schema + `plan.md` template upgrade + `parsePlanTasks` + `planParallelGroups`. Verify: parser/validation + topo/wave unit tests (disjoint-scope, deps, cycles, invalid → empty).
5. `worktree.ts` create/cleanup + orphan reaper. Verify: integration test adds/removes a worktree; cleanup on throw.
6. `fanout.ts` concurrent waves + `subImplementer` stage + template. Verify: fake-runtime test runs a wave concurrently, bounded context, costs roll up.
7. Synthesizer merge + conflict/verify fallback to sequential. Verify: conflict fixture defers a task; clean fixture lands all; tree never left conflicted.
8. `--fan-out` wiring (`cli-help`, `run-bin`, `main`/`gh-main`) + eval overlays + docs (README, ARCHITECTURE, cli-help). Verify: full suite green; `--print-config` shows new keys.

## Testing

- `model-tier.test.ts`: ladder defaults + env overrides + blank fall-through.
- `risk.test.ts` (extend): `routeModel` table — base tiers, risk up/down, escalation cap, clamps.
- `runner.test.ts` (extend): `resolveStageModel` precedence (pin > route > default); `buildArgs` gets the routed `--model`.
- `plan-tasks.test.ts`: schema validation (dup ids, dangling deps, cycles, missing file → disabled); `planParallelGroups` waves.
- `worktree.test.ts`: create yields a usable dir; cleanup removes it; orphan reaper.
- `fanout.test.ts`: injected fake runtime — wave concurrency, bounded context vars, cost roll-up, abort.
- synth/fallback test: cherry-pick conflict → task deferred + re-queued; verify-fail → deferred; tree clean after.
- `loop.test.ts` (extend): default run unchanged; `--model-routing` selects per-stage models; deferred fan-out tasks flow back into the loop.
- Gate: `pnpm -r typecheck && pnpm -r test && pnpm test`.

## Success criteria

- Default run (no new flags, no pinned model): byte-for-byte today's behavior — no tier field set means runtime default model, no worktrees.
- `--model-routing`: implementer on a docs-only change runs `cheap`; reviewer runs `strong`; three repeated failures escalate the implementer one tier; a pinned `--model` overrides all of it.
- `--plan --fan-out`: a plan with two disjoint-scope `parallelSafe` tasks runs them in parallel worktrees and lands both in one merged tree; an induced conflict defers cleanly to the sequential loop with the tree never left conflicted.
- Eval overlays produce a cost/wall-clock/success table for baseline vs routing vs fan-out.
- `typecheck` + all suites green.

## Non-goals (v1)

- Codex-runtime tier routing (keeps `OTTO_CODEX_MODEL`).
- LLM-assisted conflict resolution — conflicts fall back to sequential, never auto-merged.
- Cross-wave speculative execution or dependency-aware re-planning mid-run.
- Auto-tuning the routing policy from eval signals (the eval table informs human-committed defaults).

## Open questions (resolve in plan/impl)

1. Exact CLI model aliases the installed `claude` accepts (`haiku`/`sonnet`/`opus` vs dated IDs) — keep the ladder values overridable and document the default as best-effort; a bad alias surfaces as the runtime's own error, not an Otto crash.
2. Whether `subImplementer` reuses the `implementer` template with a tighter context block or needs its own template — decide by size in slice 6; prefer reuse with a `{{ TASK_SCOPE }}` var if it stays small.
3. Cherry-pick vs `git format-patch | git apply` for the merge step — start with cherry-pick (preserves authorship/message); revisit only if detached-HEAD edge cases bite.
4. Whether `routeModel` should also consult plan-task `fileScope` for sub-agent stages (a task touching `security` paths → `strong`) — defer to slice 6; the hook is the same `RiskAssessment`.
