# P11 Model & Sub-Agent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each Otto stage to the cheapest model tier that meets its bar (escalating on repeated failure), and fan independent plan tasks out to isolated git-worktree sub-agents that merge back with a hard fallback to today's sequential loop.

**Architecture:** Phase 1 adds a pure `model-tier.ts` (tier→model ladder + `routeModel`) and threads a per-stage model override through `executeStage`→`runStage`, gated by `--model-routing`, reusing the P2 `RiskAssessment` and the inert `decide()` escalation signal. Phase 2 upgrades the P8 plan stage to emit a machine-readable `tasks.json`, adds `worktree.ts` (isolation) + `fanout.ts` (concurrent waves + cherry-pick synth), gated by `--fan-out`, degrading to the normal loop on any conflict/verify failure.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` relative imports), vitest (`packages/core/__tests__`), node:child_process `git`, the existing `AgentRuntime` adapter + `executeStage` helper.

## Global Constraints

- **ESM only.** Every relative import in `packages/core/src/` ends in `.js`.
- **Opt-in, zero default behavior change.** A run with no new flags and no pinned model is byte-for-byte today's behavior: no `tier` field set ⇒ runtime default model; no worktrees.
- **Back-compat precedence (invariant):** an explicit `--model` / `OTTO_MODEL` / `OTTO_${RUNTIME}_MODEL` pin wins over tier routing and disables it.
- **Graceful degradation (invariant):** a missing/invalid `tasks.json` silently disables fan-out and runs the normal loop; any cherry-pick conflict or post-wave verify failure defers the task to the sequential loop — fan-out never leaves the tree conflicted.
- **`permissionMode` is always `bypassPermissions`** on every stage (existing rule).
- **Templates ship in the tarball:** a new stage = (1) add to `STAGES`, (2) add `templates/<name>.md`, (3) wire it into the chain.
- **Never hand-edit release version state** (release-please owns it).
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test` (run from repo root).
- **Default tier ladder:** `cheap=haiku`, `mid=sonnet`, `strong=opus` (CLI aliases; overridable via `OTTO_TIER_CHEAP/MID/STRONG`).

---

# Phase 1 — Per-stage model-tier routing (Tasks 1–3, mergeable on its own)

### Task 1: Tier ladder + per-stage model threading (static tiers, no router yet)

**Files:**
- Create: `packages/core/src/model-tier.ts`
- Create: `packages/core/__tests__/model-tier.test.ts`
- Modify: `packages/core/src/stages.ts` (add `tier?` to `Stage`, set default tiers)
- Modify: `packages/core/src/runner.ts` (`RunStageOptions.modelSpec`; use it in `runStage`)
- Modify: `packages/core/src/stage-exec.ts` (resolve per-stage spec, pass to `runStage`, stamp telemetry)
- Modify: `packages/core/src/index.ts` (export new symbols)
- Test: `packages/core/__tests__/model-tier.test.ts`, extend `runner.test.ts`

**Interfaces:**
- Produces:
  - `type ModelTier = "cheap" | "mid" | "strong"`
  - `type TierLadder = Record<ModelTier, string | undefined>`
  - `const DEFAULT_LADDER: TierLadder`
  - `resolveTierLadder(env?: NodeJS.ProcessEnv): TierLadder`
  - `Stage.tier?: ModelTier`
  - `RunStageOptions.modelSpec?: string` (per-call override; when set, `runStage` uses it verbatim instead of `resolveModelSelection`)
  - `StageResult.routedTier?: ModelTier`, `StageResult.routedModel?: string`, `StageResult.modelSource?: string` (telemetry, optional)
- Consumes: existing `resolveModelArgs`, `resolveModelSelection`, `executeStage`.

- [ ] **Step 1: Write the failing test for the ladder**

Create `packages/core/__tests__/model-tier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_LADDER, resolveTierLadder } from "../src/model-tier.js";

describe("resolveTierLadder", () => {
  it("returns the default ladder with no env overrides", () => {
    expect(resolveTierLadder({})).toEqual(DEFAULT_LADDER);
    expect(DEFAULT_LADDER).toEqual({ cheap: "haiku", mid: "sonnet", strong: "opus" });
  });

  it("overlays per-tier env overrides, ignoring blank values", () => {
    const ladder = resolveTierLadder({
      OTTO_TIER_CHEAP: "claude-haiku-4-5",
      OTTO_TIER_MID: "  ",
      OTTO_TIER_STRONG: "opus",
    });
    expect(ladder).toEqual({ cheap: "claude-haiku-4-5", mid: "sonnet", strong: "opus" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- model-tier`
Expected: FAIL — `Cannot find module '../src/model-tier.js'`.

- [ ] **Step 3: Implement `model-tier.ts` (ladder only for now)**

Create `packages/core/src/model-tier.ts`:

```ts
/**
 * Model-tier routing substrate (issue #66 P11). Pure: a stage's difficulty
 * `ModelTier` resolves to a concrete model spec via a config-overridable ladder,
 * and `routeModel` modulates the tier by change-risk + failure escalation. No
 * I/O, no model calls — so routing is reproducible and the eval suite can A/B it.
 */

/** Stage difficulty, low → high cost. */
export type ModelTier = "cheap" | "mid" | "strong";

/** tier → concrete model spec passed to the runtime's `--model` (undefined = runtime default). */
export type TierLadder = Record<ModelTier, string | undefined>;

/** Claude CLI aliases; overridable per tier via OTTO_TIER_*. */
export const DEFAULT_LADDER: TierLadder = {
  cheap: "haiku",
  mid: "sonnet",
  strong: "opus",
};

const ENV_OF: Record<ModelTier, string> = {
  cheap: "OTTO_TIER_CHEAP",
  mid: "OTTO_TIER_MID",
  strong: "OTTO_TIER_STRONG",
};

/** Overlay OTTO_TIER_CHEAP/MID/STRONG onto {@link DEFAULT_LADDER}; blank ⇒ default. */
export function resolveTierLadder(
  env: NodeJS.ProcessEnv = process.env
): TierLadder {
  const ladder: TierLadder = { ...DEFAULT_LADDER };
  for (const tier of ["cheap", "mid", "strong"] as const) {
    const v = env[ENV_OF[tier]]?.trim();
    if (v) ladder[tier] = v;
  }
  return ladder;
}
```

- [ ] **Step 4: Run the ladder test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- model-tier`
Expected: PASS (2 tests).

- [ ] **Step 5: Add `tier` to `Stage` and default tiers in `STAGES`**

In `packages/core/src/stages.ts`, add the import and field, then a `tier` to each stage:

```ts
import type { ModelTier } from "./model-tier.js";

export type Stage = {
  name: string;
  template: string;
  permissionMode?: string;
  /** Difficulty tier for model routing (issue #66 P11). Absent ⇒ runtime default model. */
  tier?: ModelTier;
};
```

Set tiers in `STAGES` (add `tier:` to each entry): `plan`, `reviewer`, `verifier`, `applyReviewImplementer` → `"strong"`; `implementer`, `ghafkImplementer`, `ghafkIssueImplementer`, `linearImplementer`, `linearIssueImplementer` → `"mid"`. Example:

```ts
  plan: {
    name: "plan",
    template: "plan.md",
    permissionMode: "bypassPermissions",
    tier: "strong",
  } satisfies Stage,
  implementer: {
    name: "implementer",
    template: "afk.md",
    permissionMode: "bypassPermissions",
    tier: "mid",
  } satisfies Stage,
```

- [ ] **Step 6: Thread `modelSpec` through `runStage`**

In `packages/core/src/runner.ts`, extend `RunStageOptions` (around line 31):

```ts
export type RunStageOptions = {
  signal?: AbortSignal;
  runtime?: AgentRuntime;
  sink?: EventSink;
  /** Per-stage model spec (issue #66 P11). When set, overrides the env-based
   *  resolveModelSelection — the caller (executeStage) has already applied the
   *  pin > route > default precedence. */
  modelSpec?: string;
};
```

Then in `runStage`, change the `buildArgs` model fragment (currently `runner.ts:584`) to prefer the override:

```ts
    const modelSpec =
      options.modelSpec ?? resolveModelSelection(runtime.id)?.spec;
    const argv = runtime.buildArgs(
      stage,
      promptRelPath,
      resolveModelArgs(modelSpec),
      settingsHostPath
    );
```

- [ ] **Step 7: Write the failing test for the override**

Add to `packages/core/__tests__/runner.test.ts` (it already imports `buildClaudeArgs`/`resolveModelArgs`); add a focused unit test of the precedence helper you will add in Step 8. First add the test:

```ts
import { resolveStageModel } from "../src/model-tier.js";
import { STAGES } from "../src/stages.js";

describe("resolveStageModel", () => {
  const ladder = { cheap: "haiku", mid: "sonnet", strong: "opus" } as const;

  it("returns the runtime default when routing is off", () => {
    const r = resolveStageModel({
      runtimeId: "claude", stage: STAGES.implementer, routing: false, ladder, env: {},
    });
    expect(r).toEqual({ spec: undefined, source: "default" });
  });

  it("a pinned OTTO_MODEL wins and disables routing", () => {
    const r = resolveStageModel({
      runtimeId: "claude", stage: STAGES.implementer, routing: true, ladder,
      env: { OTTO_MODEL: "my-pin" },
    });
    expect(r).toEqual({ spec: "my-pin", source: "pin" });
  });

  it("routes the stage's base tier through the ladder when on", () => {
    const r = resolveStageModel({
      runtimeId: "claude", stage: STAGES.reviewer, routing: true, ladder, env: {},
    });
    expect(r).toMatchObject({ spec: "opus", tier: "strong", source: "route" });
  });
});
```

- [ ] **Step 8: Run it to verify it fails, then implement `resolveStageModel`**

Run: `pnpm --filter @phamvuhoang/otto-core test -- runner`
Expected: FAIL — `resolveStageModel` is not exported.

Add to `packages/core/src/model-tier.ts`:

```ts
import type { Stage } from "./stages.js";
import type { AgentRuntimeId } from "./agent-runtime.js";
import { resolveModelSelection } from "./runner.js";
import type { RiskAssessment } from "./risk.js";

export type StageModel = {
  spec: string | undefined;
  tier?: ModelTier;
  source: "pin" | "route" | "default";
};

/**
 * Resolve the model spec for one stage. Precedence (back-compat invariant):
 * an explicit pin (OTTO_${RUNTIME}_MODEL / OTTO_MODEL) wins and disables
 * routing; else routing on + a declared tier ⇒ ladder[routeModel(...)]; else
 * the runtime default (undefined).
 */
export function resolveStageModel(opts: {
  runtimeId: AgentRuntimeId;
  stage: Stage;
  routing: boolean;
  ladder: TierLadder;
  assessment?: RiskAssessment;
  escalations?: number;
  env?: NodeJS.ProcessEnv;
}): StageModel {
  const pin = resolveModelSelection(opts.runtimeId, opts.env ?? process.env);
  if (pin) return { spec: pin.spec, source: "pin" };
  if (!opts.routing || !opts.stage.tier) return { spec: undefined, source: "default" };
  const { tier } = routeModel({
    baseTier: opts.stage.tier,
    assessment: opts.assessment,
    escalations: opts.escalations,
  });
  return { spec: opts.ladder[tier], tier, source: "route" };
}
```

> Note: `routeModel` is implemented in Task 2. For Task 1, add a temporary identity `routeModel` so the build/tests pass, OR sequence Step 7–8's routing assertion into Task 2. **Decision:** implement the minimal `routeModel` now (identity: returns `baseTier`) so Task 1 is self-contained and green; Task 2 replaces its body with the full rules and its own tests.

Minimal `routeModel` to add now:

```ts
/** Modulate a base tier by risk + escalation (full rules land in Task 2). */
export function routeModel(opts: {
  baseTier: ModelTier;
  assessment?: RiskAssessment;
  escalations?: number;
}): { tier: ModelTier; reasons: string[] } {
  return { tier: opts.baseTier, reasons: [] };
}
```

- [ ] **Step 9: Resolve + pass the spec in `executeStage`, stamp telemetry**

In `packages/core/src/stage-exec.ts`, extend `ExecuteStageOptions` with routing inputs and use them. Add fields:

```ts
  /** Model routing on (issue #66 P11). Off ⇒ runtime default model. */
  modelRouting?: boolean;
  tierLadder?: import("./model-tier.js").TierLadder;
  riskAssessment?: import("./risk.js").RiskAssessment;
  escalations?: number;
```

Compute the spec before `runStage` and pass it; stamp the result. Inside the `withRetries` callback, replace the `runStage(...)` call site:

```ts
import { resolveStageModel } from "./model-tier.js";
// ...
      const model = resolveStageModel({
        runtimeId: (opts.agentId ?? DEFAULT_AGENT),
        stage,
        routing: opts.modelRouting === true,
        ladder: opts.tierLadder ?? { cheap: undefined, mid: undefined, strong: undefined },
        assessment: opts.riskAssessment,
        escalations: opts.escalations,
      });
      const result = await runStage(
        stage, prompt, workspaceDir, iteration, spillHostDir, stageLog,
        { signal, runtime, sink: opts.sink, modelSpec: model.spec }
      );
      return {
        ...result,
        contextBreakdown: analyzeContext(prompt),
        ...(model.tier ? { routedTier: model.tier, routedModel: model.spec, modelSource: model.source } : {}),
        ...(violations.length > 0 ? { safetyEvents: violations.map(violationToSafetyEvent) } : {}),
      };
```

Add the optional telemetry fields to `StageResult` in `runner.ts`:

```ts
  /** Model tier this stage was routed to (issue #66 P11); absent when routing off. */
  routedTier?: import("./model-tier.js").ModelTier;
  routedModel?: string;
  modelSource?: string;
```

- [ ] **Step 10: Export new symbols**

In `packages/core/src/index.ts`, export from `./model-tier.js`: `ModelTier`, `TierLadder`, `DEFAULT_LADDER`, `resolveTierLadder`, `resolveStageModel`, `routeModel`, `StageModel`. (Match the existing export style in that file.)

- [ ] **Step 11: Run full verify**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: PASS — new ladder + precedence tests green; no existing test regresses (default `modelRouting` undefined ⇒ `runStage` falls back to `resolveModelSelection`, unchanged behavior).

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/model-tier.ts packages/core/__tests__/model-tier.test.ts \
  packages/core/src/stages.ts packages/core/src/runner.ts packages/core/src/stage-exec.ts \
  packages/core/src/index.ts packages/core/__tests__/runner.test.ts
git commit -m "feat(core): per-stage model tier ladder + threading (#66 P11 slice 1)"
```

---

### Task 2: `routeModel` rules + `--model-routing` activation + explain

**Files:**
- Modify: `packages/core/src/model-tier.ts` (full `routeModel` body)
- Modify: `packages/core/src/cli-help.ts` (`--model-routing` flag, help, `--print-config`)
- Modify: `packages/core/src/run-bin.ts` (resolve `modelRouting` + ladder; thread into `runLoop`)
- Modify: `packages/core/src/loop.ts` (compute `RiskAssessment`; pass routing inputs to `executeStage`; extend explain)
- Test: `packages/core/__tests__/model-tier.test.ts` (routeModel table), extend `cli-help.test.ts`

**Interfaces:**
- Consumes: `ModelTier`, `RiskAssessment` (from `risk.ts`), `classifyRisk`.
- Produces: full `routeModel`; `CliFlags.modelRouting: boolean`; `runLoop` option `modelRouting?: boolean` + `tierLadder?: TierLadder`.

- [ ] **Step 1: Write the failing routeModel table test**

Add to `packages/core/__tests__/model-tier.test.ts`:

```ts
import { routeModel } from "../src/model-tier.js";

const risk = (cls: string) => ({ class: cls, level: "medium", reasons: [] }) as any;

describe("routeModel", () => {
  it("returns the base tier with no signals", () => {
    expect(routeModel({ baseTier: "mid" }).tier).toBe("mid");
  });
  it("downgrades docs-only / test-only one tier (floor cheap)", () => {
    expect(routeModel({ baseTier: "mid", assessment: risk("docs-only") }).tier).toBe("cheap");
    expect(routeModel({ baseTier: "cheap", assessment: risk("test-only") }).tier).toBe("cheap");
  });
  it("upgrades security-sensitive / cross-module to strong", () => {
    expect(routeModel({ baseTier: "mid", assessment: risk("security-sensitive") }).tier).toBe("strong");
    expect(routeModel({ baseTier: "cheap", assessment: risk("cross-module") }).tier).toBe("strong");
  });
  it("escalation raises one tier per prior escalation, capped at strong", () => {
    expect(routeModel({ baseTier: "cheap", escalations: 1 }).tier).toBe("mid");
    expect(routeModel({ baseTier: "mid", escalations: 1 }).tier).toBe("strong");
    expect(routeModel({ baseTier: "mid", escalations: 5 }).tier).toBe("strong");
  });
  it("risk-up then escalation both clamp at strong", () => {
    expect(routeModel({ baseTier: "strong", assessment: risk("security-sensitive"), escalations: 2 }).tier).toBe("strong");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- model-tier`
Expected: FAIL — identity `routeModel` returns `mid`/`cheap` unchanged for the risk cases.

- [ ] **Step 3: Implement the full `routeModel`**

Replace the minimal body in `model-tier.ts`:

```ts
const ORDER: ModelTier[] = ["cheap", "mid", "strong"];
function bump(tier: ModelTier, by: number): ModelTier {
  const i = Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(tier) + by));
  return ORDER[i];
}

export function routeModel(opts: {
  baseTier: ModelTier;
  assessment?: RiskAssessment;
  escalations?: number;
}): { tier: ModelTier; reasons: string[] } {
  const reasons: string[] = [`base tier ${opts.baseTier}`];
  let tier = opts.baseTier;
  const cls = opts.assessment?.class;
  if (cls === "docs-only" || cls === "test-only") {
    tier = bump(tier, -1);
    reasons.push(`risk-down (${cls}) → ${tier}`);
  } else if (cls === "security-sensitive" || cls === "cross-module") {
    tier = "strong";
    reasons.push(`risk-up (${cls}) → strong`);
  }
  const esc = opts.escalations ?? 0;
  if (esc > 0) {
    tier = bump(tier, esc);
    reasons.push(`escalated ×${esc} → ${tier}`);
  }
  return { tier, reasons };
}
```

- [ ] **Step 4: Run the table test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- model-tier`
Expected: PASS (all routeModel cases).

- [ ] **Step 5: Add the `--model-routing` flag (failing cli-help test first)**

Add to `packages/core/__tests__/cli-help.test.ts` (match existing flag-test style):

```ts
it("parses --model-routing", () => {
  expect(parseFlags(["--model-routing"]).modelRouting).toBe(true);
  expect(parseFlags([]).modelRouting).toBe(false);
});
```

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help` → FAIL (`modelRouting` undefined).

- [ ] **Step 6: Implement the flag**

In `cli-help.ts`: add `modelRouting: boolean;` to `CliFlags`; default it `false` in the initializer; add a `case "--model-routing": flags.modelRouting = true; break;` in the parse loop (mirror `--adaptive-router`); add a help line under the routing section: `  --model-routing          Route each stage to a model tier by difficulty + risk (off by default)`.

Run: `pnpm --filter @phamvuhoang/otto-core test -- cli-help` → PASS.

- [ ] **Step 7: Resolve `modelRouting` + ladder in `run-bin.ts`**

Mirror the `adaptiveRouter` resolution block. Add:

```ts
import { resolveTierLadder } from "./model-tier.js";

const modelRouting =
  flags.modelRouting ||
  ["1", "true", "yes", "on"].includes(
    (process.env.OTTO_MODEL_ROUTING ?? "").trim().toLowerCase()
  );
const tierLadder = resolveTierLadder(process.env);
```

Thread `modelRouting` and `tierLadder` into the `runLoop({...})` options object. Add both to the `--print-config` output block (e.g. `modelRouting`, and the resolved ladder `cheap/mid/strong`).

- [ ] **Step 8: Consume routing inputs in `loop.ts`**

In `loop.ts`'s `runLoop`:
1. Accept `modelRouting?: boolean` and `tierLadder?: TierLadder` in the options type.
2. Each iteration, compute the change assessment once (reuse the existing `changedFilesSince` call already used for the adaptive router; if model-routing is on but adaptive-router is off, still call `classifyRisk(changed)`):

```ts
import { classifyRisk } from "./risk.js";
const assessment = (modelRouting || adaptiveRouter)
  ? classifyRisk(changedPaths)
  : undefined;
```

3. Pass routing inputs into every `executeStage(...)` call in the loop body:

```ts
  modelRouting,
  tierLadder,
  riskAssessment: assessment,
  escalations: modelEscalations, // 0 until Task 3 wires the policy
```

(Define `let modelEscalations = 0;` near the loop's running counters for now.)

4. Under `--explain-routing`, when `modelRouting` and a stage was routed, print one line per stage. After a stage result, if `sr.routedTier`:

```ts
if (explainRouting && sr.routedTier) {
  const src = sr.modelSource === "route" ? "" : ` [${sr.modelSource}]`;
  process.stderr.write(dim(`route: ${stage.name} → ${sr.routedTier} (${sr.routedModel ?? "default"})${src}\n`));
}
```

- [ ] **Step 9: Run full verify**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: PASS. Default runs unchanged (routing off).

- [ ] **Step 10: Manual smoke (no spend) — confirm argv**

Run: `OTTO_MODEL_ROUTING=1 node -e "const {resolveStageModel,resolveTierLadder}=require('./packages/core/dist/model-tier.js');const {STAGES}=require('./packages/core/dist/stages.js');console.log(resolveStageModel({runtimeId:'claude',stage:STAGES.reviewer,routing:true,ladder:resolveTierLadder({}),env:{}}))"`
(Run `pnpm -r build` first.) Expected: `{ spec: 'opus', tier: 'strong', source: 'route' }`.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/model-tier.ts packages/core/src/cli-help.ts \
  packages/core/src/run-bin.ts packages/core/src/loop.ts \
  packages/core/__tests__/model-tier.test.ts packages/core/__tests__/cli-help.test.ts
git commit -m "feat(core): model routing rules + --model-routing activation (#66 P11 slice 2)"
```

---

### Task 3: Escalation tier-bump from repeated failure

**Files:**
- Modify: `packages/core/src/loop.ts` (track repeated-failure streak → `modelEscalations`)
- Test: extend `packages/core/__tests__/loop.test.ts`

**Interfaces:**
- Consumes: the existing `decide()` / `PolicyContext.repeatedFailureStreak` already computed in the loop (P2). `routeModel`'s `escalations`.
- Produces: a per-run `modelEscalations` count fed into `executeStage` so the implementer/reviewer rise a tier after repeated failures.

- [ ] **Step 1: Write the failing test**

The loop test harness mocks stages. Add a test asserting that after `REPEATED_FAILURE_LIMIT` (3) same-signature failures, the implementer stage is invoked with a strong-tier model when routing is on. Inspect the existing `loop.test.ts` mock for `runStage`/`executeStage` (it injects a fake). Assert on the `modelSpec` the fake receives. Sketch:

```ts
it("escalates the model tier after repeated failures when routing is on", async () => {
  const specs: (string | undefined)[] = [];
  // fake executeStage/runStage records options.modelSpec per call (see existing harness)
  // drive 3 iterations whose progress signals repeat the same failure
  // assert the later implementer call's modelSpec === "opus"
  expect(specs.at(-1)).toBe("opus");
});
```

> If `loop.test.ts` mocks at the `executeStage` boundary, assert on the `escalations`/routing inputs it received instead; the deterministic unit coverage of the bump itself already lives in `model-tier.test.ts` (Task 2). Keep this test at whatever seam the existing harness uses.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- loop`
Expected: FAIL — escalation count stays 0, model stays `sonnet`.

- [ ] **Step 3: Wire the escalation count**

In `loop.ts`, the loop already maintains the `PolicyContext` (`repeatedFailureStreak`) for the P2 policy. Set:

```ts
// Repeated failures escalate the model tier (issue #66 P11). Tie to the same
// streak the policy uses; one tier per failure beyond the first.
const modelEscalations = Math.max(0, policyCtx.repeatedFailureStreak - 1);
```

placed where `policyCtx` is current for the iteration, before the stage executes. Replace the `let modelEscalations = 0;` placeholder from Task 2.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- loop`
Expected: PASS.

- [ ] **Step 5: Full verify + commit**

```bash
git add packages/core/src/loop.ts packages/core/__tests__/loop.test.ts
git commit -m "feat(core): escalate model tier on repeated failure (#66 P11 slice 3)"
```

> **Phase 1 mergeable here.** `pnpm -r typecheck && pnpm -r test && pnpm test` green. Routing is opt-in, pins still win, default unchanged.

---

# Phase 2 — Sub-agent fan-out (Tasks 4–8, opt-in)

### Task 4: `tasks.json` schema, plan template upgrade, parser, wave grouping

**Files:**
- Create: `packages/core/src/plan-tasks.ts`
- Create: `packages/core/__tests__/plan-tasks.test.ts`
- Modify: `packages/core/templates/plan.md` (instruct the planner to emit `tasks.json`)
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Produces:
  - `type PlanTask = { id: string; title: string; fileScope: string[]; dependsOn: string[]; parallelSafe: boolean }`
  - `parsePlanTasks(json: string): PlanTask[]` — throws-free; returns `[]` on any invalid/missing input.
  - `planParallelGroups(tasks: PlanTask[]): PlanTask[][]` — waves of independent tasks.
  - `readPlanTasks(workspaceDir: string, taskKey: string): PlanTask[]` (reads `.otto/tasks/<taskKey>/tasks.json`).

- [ ] **Step 1: Write the failing parser/grouping tests**

Create `packages/core/__tests__/plan-tasks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parsePlanTasks, planParallelGroups } from "../src/plan-tasks.js";

const J = (o: unknown) => JSON.stringify(o);

describe("parsePlanTasks", () => {
  it("parses a valid task graph", () => {
    const tasks = parsePlanTasks(J({ version: 1, tasks: [
      { id: "t1", title: "A", fileScope: ["a.ts"], dependsOn: [], parallelSafe: true },
    ]}));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("t1");
  });
  it("returns [] on invalid JSON", () => {
    expect(parsePlanTasks("{ not json")).toEqual([]);
  });
  it("returns [] on duplicate ids", () => {
    expect(parsePlanTasks(J({ tasks: [
      { id: "t1", title: "A", fileScope: [], dependsOn: [], parallelSafe: true },
      { id: "t1", title: "B", fileScope: [], dependsOn: [], parallelSafe: true },
    ]}))).toEqual([]);
  });
  it("returns [] on a dangling dependency", () => {
    expect(parsePlanTasks(J({ tasks: [
      { id: "t1", title: "A", fileScope: [], dependsOn: ["nope"], parallelSafe: true },
    ]}))).toEqual([]);
  });
  it("returns [] on a dependency cycle", () => {
    expect(parsePlanTasks(J({ tasks: [
      { id: "t1", title: "A", fileScope: [], dependsOn: ["t2"], parallelSafe: true },
      { id: "t2", title: "B", fileScope: [], dependsOn: ["t1"], parallelSafe: true },
    ]}))).toEqual([]);
  });
});

describe("planParallelGroups", () => {
  const t = (id: string, fileScope: string[], dependsOn: string[] = [], parallelSafe = true) =>
    ({ id, title: id, fileScope, dependsOn, parallelSafe });

  it("groups disjoint parallel-safe tasks into one wave", () => {
    const w = planParallelGroups([t("t1", ["a.ts"]), t("t2", ["b.ts"])]);
    expect(w).toHaveLength(1);
    expect(w[0].map((x) => x.id).sort()).toEqual(["t1", "t2"]);
  });
  it("splits overlapping file scopes into separate waves", () => {
    const w = planParallelGroups([t("t1", ["a.ts"]), t("t2", ["a.ts"])]);
    expect(w).toHaveLength(2);
  });
  it("respects dependencies (dependent task in a later wave)", () => {
    const w = planParallelGroups([t("t1", ["a.ts"]), t("t2", ["b.ts"], ["t1"])]);
    expect(w[0].map((x) => x.id)).toEqual(["t1"]);
    expect(w[1].map((x) => x.id)).toEqual(["t2"]);
  });
  it("puts a non-parallel-safe task in its own singleton wave", () => {
    const w = planParallelGroups([t("t1", ["a.ts"]), t("t2", ["b.ts"], [], false)]);
    expect(w.some((wave) => wave.length === 1 && wave[0].id === "t2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- plan-tasks`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `plan-tasks.ts`**

Create `packages/core/src/plan-tasks.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One decomposed plan task (issue #66 P11 fan-out). */
export type PlanTask = {
  id: string;
  title: string;
  fileScope: string[];
  dependsOn: string[];
  parallelSafe: boolean;
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validShape(t: unknown): t is PlanTask {
  const o = t as Record<string, unknown>;
  return (
    !!o &&
    typeof o.id === "string" && o.id.length > 0 &&
    typeof o.title === "string" &&
    isStringArray(o.fileScope) &&
    isStringArray(o.dependsOn) &&
    typeof o.parallelSafe === "boolean"
  );
}

/** True if the dependsOn graph has a cycle. */
function hasCycle(tasks: PlanTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=on-stack 2=done
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const d of byId.get(id)!.dependsOn) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

/**
 * Parse + validate a tasks.json string. Returns [] on ANY problem (bad JSON,
 * shape, duplicate id, dangling dep, cycle) so fan-out degrades to the normal
 * loop — a bad plan artifact never aborts a run.
 */
export function parsePlanTasks(json: string): PlanTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const raw = (parsed as Record<string, unknown>)?.tasks;
  if (!Array.isArray(raw) || !raw.every(validShape)) return [];
  const tasks = raw as PlanTask[];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) return [];
    ids.add(t.id);
  }
  for (const t of tasks) {
    if (t.dependsOn.some((d) => !ids.has(d))) return [];
  }
  if (hasCycle(tasks)) return [];
  return tasks;
}

/** Read + parse `.otto/tasks/<taskKey>/tasks.json`; [] when absent/invalid. */
export function readPlanTasks(workspaceDir: string, taskKey: string): PlanTask[] {
  try {
    const txt = readFileSync(
      join(workspaceDir, ".otto", "tasks", taskKey, "tasks.json"),
      "utf8"
    );
    return parsePlanTasks(txt);
  } catch {
    return [];
  }
}

/**
 * Group tasks into execution waves. A task joins the current wave iff all its
 * deps are in earlier waves, it is parallelSafe, and its fileScope is disjoint
 * from every task already in this wave. Non-parallel-safe (or scope-overlapping)
 * tasks fall to later/singleton waves. Assumes a validated (acyclic) graph.
 */
export function planParallelGroups(tasks: PlanTask[]): PlanTask[][] {
  const waves: PlanTask[][] = [];
  const done = new Set<string>();
  const remaining = [...tasks];
  while (remaining.length > 0) {
    const wave: PlanTask[] = [];
    const usedScope = new Set<string>();
    for (const t of remaining) {
      const depsReady = t.dependsOn.every((d) => done.has(d));
      const disjoint = t.fileScope.every((f) => !usedScope.has(f));
      const soloOk = t.parallelSafe || wave.length === 0;
      if (depsReady && disjoint && soloOk) {
        if (!t.parallelSafe && wave.length > 0) continue; // must be alone
        wave.push(t);
        t.fileScope.forEach((f) => usedScope.add(f));
        if (!t.parallelSafe) break; // singleton wave
      }
    }
    if (wave.length === 0) {
      // deadlock guard (should not happen on a validated graph): emit the rest as singletons
      waves.push([remaining[0]]);
      done.add(remaining[0].id);
      remaining.splice(remaining.indexOf(remaining[0]), 1);
      continue;
    }
    for (const t of wave) {
      done.add(t.id);
      remaining.splice(remaining.indexOf(t), 1);
    }
    waves.push(wave);
  }
  return waves;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- plan-tasks`
Expected: PASS (all parser + grouping cases).

- [ ] **Step 5: Upgrade `plan.md` to emit `tasks.json`**

In `packages/core/templates/plan.md`, after the plan-authoring instructions, add a section (no code, prose for the agent) instructing it to also write `.otto/tasks/<task-key>/tasks.json` with the exact schema, e.g.:

```markdown
## Machine-readable task graph (for fan-out)

After writing `plan.md`, also write `.otto/tasks/<task-key>/tasks.json` describing the
plan's tasks as a JSON object: `{ "version": 1, "tasks": [ { "id", "title",
"fileScope": [paths you expect to touch], "dependsOn": [ids], "parallelSafe": <true
only if this task shares no files and no ordering with its siblings> } ] }`. Be
conservative: set `parallelSafe` false whenever unsure. This file is optional — if
you cannot decompose cleanly, omit it and the run proceeds sequentially.
```

(Use the same `<task-key>` substitution the template already uses for `spec.md`/`plan.md`; match the existing path convention.)

- [ ] **Step 6: Export + commit**

Add `plan-tasks.js` exports to `index.ts` (`PlanTask`, `parsePlanTasks`, `planParallelGroups`, `readPlanTasks`).

```bash
git add packages/core/src/plan-tasks.ts packages/core/__tests__/plan-tasks.test.ts \
  packages/core/templates/plan.md packages/core/src/index.ts
git commit -m "feat(core): tasks.json schema + wave grouping (#66 P11 slice 4)"
```

---

### Task 5: Git-worktree isolation primitive

**Files:**
- Create: `packages/core/src/worktree.ts`
- Create: `packages/core/__tests__/worktree.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `git()` from `git.js`.
- Produces:
  - `createWorktree(workspaceDir: string, id: string): { dir: string; cleanup: () => void }`
  - `reapWorktrees(workspaceDir: string): void` (prune `.otto-tmp/wt/*` orphans)

- [ ] **Step 1: Write the failing integration test**

Create `packages/core/__tests__/worktree.test.ts`. Set up a temp git repo in `os.tmpdir()`, one commit, then:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../src/worktree.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "otto-wt-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "f.txt"), "hi");
  g("add", "."); g("commit", "-qm", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

it("creates an isolated worktree at HEAD and cleans it up", () => {
  const wt = createWorktree(repo, "t1");
  expect(existsSync(join(wt.dir, "f.txt"))).toBe(true);
  expect(wt.dir).toContain(join(".otto-tmp", "wt", "t1"));
  wt.cleanup();
  expect(existsSync(wt.dir)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- worktree`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `worktree.ts`**

```ts
import { rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";

/**
 * Create an isolated git worktree at HEAD under `.otto-tmp/wt/<id>` (inside the
 * workspace, so the native sandbox still confines writes). `--detach` so the
 * sub-agent commits onto a detached HEAD without touching a branch. cleanup()
 * removes it; safe to call twice.
 */
export function createWorktree(
  workspaceDir: string,
  id: string
): { dir: string; cleanup: () => void } {
  const rel = join(".otto-tmp", "wt", id);
  const dir = join(workspaceDir, rel);
  git(["worktree", "add", "--detach", dir, "HEAD"], workspaceDir);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    git(["worktree", "remove", "--force", dir], workspaceDir);
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

/** Prune leftover worktrees from a crashed prior run, then GC git's registry. */
export function reapWorktrees(workspaceDir: string): void {
  rmSync(join(workspaceDir, ".otto-tmp", "wt"), { recursive: true, force: true });
  git(["worktree", "prune"], workspaceDir);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- worktree`
Expected: PASS.

- [ ] **Step 5: Export + commit**

```bash
git add packages/core/src/worktree.ts packages/core/__tests__/worktree.test.ts packages/core/src/index.ts
git commit -m "feat(core): git-worktree isolation primitive (#66 P11 slice 5)"
```

---

### Task 6: Concurrent fan-out executor + `subImplementer` stage

**Files:**
- Create: `packages/core/src/fanout.ts`
- Create: `packages/core/templates/subtask.md`
- Create: `packages/core/__tests__/fanout.test.ts`
- Modify: `packages/core/src/stages.ts` (add `subImplementer` to `STAGES`)
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `planParallelGroups`, `PlanTask`, `createWorktree`/`reapWorktrees`, `executeStage`, `StageResult`, `TierLadder`.
- Produces:
  - `type FanoutTaskOutcome = { task: PlanTask; status: "landed" | "deferred"; reason?: string }`
  - `type FanoutResult = { outcomes: FanoutTaskOutcome[]; deferred: PlanTask[] }`
  - `runFanout(opts): Promise<FanoutResult>` (merge/synth lands in Task 7; Task 6 runs waves + collects per-task `StageResult`s; for testability it accepts an injectable `runTask` so the test never spawns a model).

- [ ] **Step 1: Add the `subImplementer` stage + template**

In `stages.ts` `STAGES`:

```ts
  subImplementer: {
    name: "sub-implementer",
    template: "subtask.md",
    permissionMode: "bypassPermissions",
    tier: "mid",
  } satisfies Stage,
```

Create `packages/core/templates/subtask.md` — a bounded-context implementer prompt. It must: state it is implementing ONE task; inject `{{ TASK_TITLE }}` and `{{ TASK_SCOPE }}` (newline list of files); include the standard learnings block (`@include` the same learnings partial `afk.md` uses — check `afk.md` for the exact tag) and the feedback-loop/commit rules; instruct it to make a single commit scoped to its files and NOT touch files outside its scope. Keep it short — this is the P7 context-isolation win.

- [ ] **Step 2: Write the failing executor test (injected runner, no model)**

Create `packages/core/__tests__/fanout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runFanout } from "../src/fanout.js";

const t = (id: string, fileScope: string[], dependsOn: string[] = []) =>
  ({ id, title: id, fileScope, dependsOn, parallelSafe: true });

it("runs disjoint tasks in one wave and reports per-task outcomes", async () => {
  const started: string[] = [];
  const res = await runFanout({
    tasks: [t("t1", ["a.ts"]), t("t2", ["b.ts"])],
    workspaceDir: "/tmp/x", packageDir: "/tmp/pkg", iteration: 1,
    maxRetries: 0, cooldownMs: 0, concurrency: 2,
    ladder: { cheap: "haiku", mid: "sonnet", strong: "opus" },
    routing: true, runtimeId: "claude",
    // injected: never spawns; returns a fake landed result
    runTask: async (task) => { started.push(task.id); return { ok: true }; },
  });
  expect(started.sort()).toEqual(["t1", "t2"]);
  expect(res.outcomes.map((o) => o.status)).toEqual(["landed", "landed"]);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- fanout`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `fanout.ts` (waves + bounded concurrency; merge deferred to Task 7)**

```ts
import type { PlanTask } from "./plan-tasks.js";
import { planParallelGroups } from "./plan-tasks.js";
import type { TierLadder } from "./model-tier.js";
import type { AgentRuntimeId } from "./agent-runtime.js";

export type FanoutTaskOutcome = {
  task: PlanTask;
  status: "landed" | "deferred";
  reason?: string;
};
export type FanoutResult = { outcomes: FanoutTaskOutcome[]; deferred: PlanTask[] };

/** Injectable per-task runner so tests never spawn a model. Returns whether the
 *  task's worktree change merged cleanly (Task 7 supplies the real impl). */
export type RunTask = (task: PlanTask) => Promise<{ ok: boolean; reason?: string }>;

export type RunFanoutOptions = {
  tasks: PlanTask[];
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  cooldownMs: number;
  concurrency: number;
  ladder: TierLadder;
  routing: boolean;
  runtimeId: AgentRuntimeId;
  signal?: AbortSignal;
  runTask: RunTask;
};

/** Bounded-concurrency map: at most `limit` promises in flight. */
async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Run the plan's tasks wave-by-wave; collect landed/deferred outcomes. */
export async function runFanout(opts: RunFanoutOptions): Promise<FanoutResult> {
  const waves = planParallelGroups(opts.tasks);
  const outcomes: FanoutTaskOutcome[] = [];
  for (const wave of waves) {
    if (opts.signal?.aborted) break;
    const results = await mapPool(wave, opts.concurrency, async (task) => {
      const r = await opts.runTask(task);
      return { task, status: r.ok ? "landed" as const : "deferred" as const, reason: r.reason };
    });
    outcomes.push(...results);
  }
  return { outcomes, deferred: outcomes.filter((o) => o.status === "deferred").map((o) => o.task) };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- fanout`
Expected: PASS.

- [ ] **Step 6: Export + commit**

```bash
git add packages/core/src/fanout.ts packages/core/templates/subtask.md \
  packages/core/__tests__/fanout.test.ts packages/core/src/stages.ts packages/core/src/index.ts
git commit -m "feat(core): concurrent fan-out executor + sub-implementer stage (#66 P11 slice 6)"
```

---

### Task 7: Worktree sub-agent runner + cherry-pick synth + fallback

**Files:**
- Modify: `packages/core/src/fanout.ts` (real `runTask`: worktree → sub-stage → cherry-pick; verify gate)
- Create: `packages/core/__tests__/fanout-merge.test.ts`

**Interfaces:**
- Consumes: `createWorktree`, `executeStage`, `git`, `headSha`.
- Produces: `defaultRunTask(task, ctx): Promise<{ ok, reason? }>` — used when `runFanout` is called without an injected `runTask`. Makes `runTask` optional in `RunFanoutOptions`.

- [ ] **Step 1: Write the failing merge/conflict test**

Create `packages/core/__tests__/fanout-merge.test.ts`. Build a temp git repo (as in `worktree.test.ts`). Define a fake `executeStage`-like runner injected into `defaultRunTask` that, given a worktree dir, writes a file + commits there. Test two cases:

```ts
// disjoint files → both cherry-pick cleanly → both "landed", tree has both files, no conflict markers
// same file, divergent content → second cherry-pick conflicts → that task "deferred", git status clean (aborted)
```

Assert after the run: `git status --porcelain` is clean (no `UU`/conflict), and the deferred task's file change is NOT present.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- fanout-merge`
Expected: FAIL — `defaultRunTask` not exported.

- [ ] **Step 3: Implement `defaultRunTask` + wire into `runFanout`**

Add to `fanout.ts`:

```ts
import { createWorktree } from "./worktree.js";
import { executeStage } from "./stage-exec.js";
import { STAGES } from "./stages.js";
import { git } from "./git.js";
import { headSha } from "./git.js";

/** Run one task in an isolated worktree, then cherry-pick its commit(s) onto the
 *  workspace HEAD. Clean → landed; conflict → abort + deferred (tree untouched). */
export async function defaultRunTask(
  task: PlanTask,
  ctx: Omit<RunFanoutOptions, "tasks" | "runTask">
): Promise<{ ok: boolean; reason?: string }> {
  const wt = createWorktree(ctx.workspaceDir, task.id);
  try {
    const before = headSha(wt.dir);
    await executeStage({
      stage: STAGES.subImplementer,
      vars: { TASK_TITLE: task.title, TASK_SCOPE: task.fileScope.join("\n") },
      workspaceDir: wt.dir,
      packageDir: ctx.packageDir,
      iteration: ctx.iteration,
      maxRetries: ctx.maxRetries,
      signal: ctx.signal,
      agentId: ctx.runtimeId,
      modelRouting: ctx.routing,
      tierLadder: ctx.ladder,
      logLabel: `sub-${task.id}`,
    });
    const after = headSha(wt.dir);
    if (!after || after === before) {
      return { ok: false, reason: "sub-agent made no commit" };
    }
    // Cherry-pick the worktree's new commit(s) onto the main HEAD.
    const range = `${before}..${after}`;
    const picked = git(["cherry-pick", range], ctx.workspaceDir);
    if (picked == null) {
      git(["cherry-pick", "--abort"], ctx.workspaceDir);
      return { ok: false, reason: "cherry-pick conflict" };
    }
    return { ok: true };
  } finally {
    wt.cleanup();
  }
}
```

Make `runTask` optional in `RunFanoutOptions` and default it:

```ts
  const runTask = opts.runTask ?? ((task: PlanTask) => defaultRunTask(task, opts));
```

(Use `runTask` in the `mapPool` call instead of `opts.runTask`.)

> **Note on the verify gate:** after each wave's merges, the loop (Task 8) runs the configured verify once; a red result defers that wave's just-landed tasks by `git reset --hard` back to the pre-wave sha and re-queues them. Keep the per-wave pre-sha in `runFanout` so Task 8 can request the reset. For Task 7, the cherry-pick conflict path is the tested guarantee; the verify-gate reset is exercised in Task 8's loop test.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- fanout-merge`
Expected: PASS — disjoint lands both; conflict defers cleanly; tree never conflicted.

- [ ] **Step 5: Full verify + commit**

```bash
git add packages/core/src/fanout.ts packages/core/__tests__/fanout-merge.test.ts
git commit -m "feat(core): worktree sub-agent runner + cherry-pick synth + conflict fallback (#66 P11 slice 7)"
```

---

### Task 8: Loop wiring, `--fan-out` flags, eval overlays, docs

**Files:**
- Modify: `packages/core/src/cli-help.ts` (`--fan-out`, `--fan-out-concurrency`, help, print-config)
- Modify: `packages/core/src/run-bin.ts` (resolve flags/env; thread into `runLoop`)
- Modify: `packages/core/src/loop.ts` (when `fanOut` + valid `tasks.json`: `reapWorktrees` → `runFanout` in place of the implementer stage; re-queue deferred tasks sequentially; record outcomes for the report)
- Modify: `packages/core/src/main.ts` / `gh-main.ts` (pass new options through)
- Modify: `packages/core/src/eval-run.ts` or the eval config source (add `model-routing` + `fan-out` overlays)
- Modify: `README.md`, `docs/ARCHITECTURE.md` (document new flags/env + the fan-out flow)
- Test: extend `packages/core/__tests__/loop.test.ts`

**Interfaces:**
- Consumes: `runFanout`, `readPlanTasks`, `deriveTaskKey` (`task-key.ts`), `FanoutResult`.
- Produces: `CliFlags.fanOut: boolean`, `CliFlags.fanOutConcurrency: number`; `runLoop` options `fanOut?`, `fanOutConcurrency?`.

- [ ] **Step 1: Add the flags (failing cli-help test first)**

Add to `cli-help.test.ts`:

```ts
it("parses --fan-out and --fan-out-concurrency", () => {
  const f = parseFlags(["--fan-out", "--fan-out-concurrency", "4"]);
  expect(f.fanOut).toBe(true);
  expect(f.fanOutConcurrency).toBe(4);
  expect(parseFlags([]).fanOut).toBe(false);
});
it("rejects a non-positive fan-out concurrency", () => {
  expect(() => parseFlags(["--fan-out-concurrency", "0"])).toThrow();
});
```

Run → FAIL.

- [ ] **Step 2: Implement the flags**

In `cli-help.ts`: add `fanOut: boolean` (default false) and `fanOutConcurrency: number` (default 3) to `CliFlags`; parse `--fan-out` (boolean) and `--fan-out-concurrency <n>` (parseInt, must be ≥ 1, throw a validation error mirroring `--max-retries`); add help lines; surface both in `--print-config`. Run cli-help test → PASS.

- [ ] **Step 3: Resolve in `run-bin.ts`**

```ts
const fanOut =
  flags.fanOut ||
  ["1", "true", "yes", "on"].includes((process.env.OTTO_FAN_OUT ?? "").trim().toLowerCase());
const fanOutConcurrency = flags.fanOutConcurrency; // already defaulted to 3
```

Thread `fanOut`, `fanOutConcurrency` into `runLoop`. Add to `--print-config`.

- [ ] **Step 4: Wire into `loop.ts`**

In `runLoop`, before the implementer stage runs each iteration, if `fanOut` is on:

```ts
import { readPlanTasks, planParallelGroups } from "./plan-tasks.js";
import { runFanout } from "./fanout.js";
import { reapWorktrees } from "./worktree.js";
import { deriveTaskKey } from "./task-key.js";

if (fanOut) {
  const taskKey = deriveTaskKey(/* the loop's WorkSource — match existing P8 usage */);
  const planTasks = readPlanTasks(workspaceDir, taskKey);
  if (planTasks.length > 0) {
    reapWorktrees(workspaceDir);
    const fr = await runFanout({
      tasks: planTasks, workspaceDir, packageDir, iteration,
      maxRetries, cooldownMs, concurrency: fanOutConcurrency,
      ladder: tierLadder ?? resolveTierLadder(process.env),
      routing: modelRouting === true, runtimeId: agent.id, signal,
    });
    // Deferred tasks fall through to the normal implementer stage this iteration
    // (sequential, safe path). Record fr.outcomes for the run report / done card.
    recordFanout?.(fr);
    if (fr.deferred.length === 0) {
      // all tasks landed via fan-out — let the reviewer run, skip the implementer
    }
  } else {
    process.stderr.write(dim("fan-out: no valid tasks.json — running sequentially\n"));
  }
}
```

Keep it minimal and match the loop's actual control structure: the invariant is *deferred or un-decomposable work always still flows through the existing sequential implementer*, so correctness never depends on fan-out succeeding. (Exact placement: wherever the implementer `executeStage` is called in the iteration body.)

- [ ] **Step 5: Add the verify-gate reset (per-wave)**

If the loop has a configured verify command (the `--verify` stage / `STAGES.verifier`), after `runFanout` returns with landed tasks, run it once; on failure `git reset --hard <pre-fanout-sha>` and treat ALL fanned tasks as deferred (re-queue sequentially). Capture the pre-fanout sha with `headSha(workspaceDir)` before `runFanout`.

- [ ] **Step 6: Loop test for degradation**

Add a `loop.test.ts` case: with `fanOut: true` but no `tasks.json`, the loop runs exactly the normal sequential path (assert the implementer stage was invoked, no worktree calls). This locks the graceful-degradation invariant.

Run: `pnpm --filter @phamvuhoang/otto-core test -- loop` → PASS.

- [ ] **Step 7: Eval overlays**

In the eval config source (where `EvalConfig[]` is defined — find via `grep -rn "label:" packages/core/src/eval*.ts bench*`), add:

```ts
{ label: "model-routing", args: ["--model-routing"], env: {} },
{ label: "fan-out", args: ["--plan", "--fan-out"], env: {} },
```

alongside the existing baseline config, so `eval-run` produces a cost/wall-clock/success comparison table.

- [ ] **Step 8: Docs**

- `README.md`: under the flags/env reference, document `--model-routing` / `OTTO_MODEL_ROUTING`, `OTTO_TIER_CHEAP/MID/STRONG`, `--fan-out` / `OTTO_FAN_OUT`, `--fan-out-concurrency`. Note pin-wins precedence and the `tasks.json` requirement for fan-out.
- `docs/ARCHITECTURE.md`: add a short "Model & sub-agent orchestration (P11)" subsection — `model-tier.ts` routing, `fanout.ts` waves + worktree isolation + cherry-pick fallback.

- [ ] **Step 9: Full verify**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: PASS across core vitest + root node:test.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/cli-help.ts packages/core/src/run-bin.ts packages/core/src/loop.ts \
  packages/core/src/main.ts packages/core/src/gh-main.ts packages/core/src/eval-run.ts \
  packages/core/__tests__/loop.test.ts packages/core/__tests__/cli-help.test.ts \
  README.md docs/ARCHITECTURE.md
git commit -m "feat(core): --fan-out loop wiring + eval overlays + docs (#66 P11 slice 8)"
```

---

## Self-Review

**Spec coverage:**
- Part A per-stage tier policy → Tasks 1–2 ✓; escalation → Task 3 ✓; precedence (pin wins) → Task 1 Step 7–8 ✓; telemetry/explain → Task 1 Step 9 + Task 2 Step 8 ✓.
- Part B task graph → Task 4 ✓; worktree isolation → Task 5 ✓; concurrent executor → Task 6 ✓; synth + conflict/verify fallback → Tasks 7–8 ✓; bounded sub-agent context → Task 6 `subtask.md` ✓.
- Part C eval overlays → Task 8 Step 7 ✓.
- Non-goals (Codex tiering, LLM merge, auto-tune) → respected (no tasks add them).

**Placeholder scan:** The two soft spots are deliberate and called out, not hidden: (1) Task 1 Step 8 ships a minimal identity `routeModel` replaced wholesale in Task 2 (sequencing decision, stated); (2) Task 8 Step 4 placement depends on the live `loop.ts` control structure — the implementer must read the current iteration body, but the invariant (deferred work flows through the sequential implementer) is exact. Task 3 Step 1 and Task 7 Step 1 reference "the existing harness/repo setup" — acceptable because they mirror patterns already in `loop.test.ts` / `worktree.test.ts` shown in this plan.

**Type consistency:** `ModelTier`, `TierLadder`, `StageModel`, `resolveStageModel`, `routeModel`, `PlanTask`, `FanoutResult`, `RunTask`, `defaultRunTask` names are used identically across tasks. `RunStageOptions.modelSpec` (Task 1) is consumed by `executeStage` (Task 1) and `defaultRunTask` (Task 7). `Stage.tier` (Task 1) is read by `resolveStageModel` (Task 1) and set for `subImplementer` (Task 6).

**Verification:** every task ends green on `pnpm --filter @phamvuhoang/otto-core test` (scoped) and the full `pnpm -r typecheck && pnpm -r test && pnpm test` at phase boundaries.
