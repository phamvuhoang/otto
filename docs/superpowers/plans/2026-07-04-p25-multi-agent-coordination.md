# P25 Multi-Agent Coordination Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Otto's `--fan-out` a reliable default for parallelizable work through smarter conflict prediction, structured sub-agent handoffs, a conflict-aware synthesizer, and per-agent + defer-reason evidence in reports.

**Architecture:** Upgrade `plan-tasks.ts` conflict detection from exact-string disjointness to prefix/glob/directory overlap plus a plan-map-reconciled confidence score. Sub-agents emit a `handoff.json` the synthesizer reads to order merges (lowest-conflict first) and defer risky ones with reasons. Fan-out outcomes, contributions, and defer reasons flow into stage records, the run manifest, and the report. All changes are inert outside `--fan-out`.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥20, vitest. `packages/core` only. No new npm dependencies.

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **No new npm dependencies.**
- **Opt-in only.** All behavior lives under the existing `--fan-out` path; sequential (non-fan-out) runs are unchanged.
- **Throws-free contract.** Every new parser/predicate degrades to a safe default (safe singleton waves, minimal handoff) rather than aborting a run — matching `parsePlanTasks` (`plan-tasks.ts:63-83`).
- **No content/AST analysis.** Conflict prediction is static path overlap + plan-map reconciliation only.
- **No auto conflict resolution.** Risky merges are deferred with a legible reason, never auto-merged.
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit runs prettier + typecheck.
- **Never hand-edit release version state.** release-please owns it.

---

### Task 1: Conflict prediction — overlap detection + plan-map-reconciled confidence

**Files:**

- Modify: `packages/core/src/plan-tasks.ts` (`planParallelGroups` at `:140-173`; new `ConflictPrediction` + `predictConflicts`)
- Modify: `packages/core/src/index.ts` (export new type + functions)
- Test: `packages/core/src/__tests__/conflict-prediction.test.ts`

**Interfaces:**

- Consumes: `PlanTask` (`plan-tasks.ts:14-23`), `extractPlanFileMap(doc): string[]` (`plan-rubric.ts:173`).
- Produces:
  - `export type ConflictPrediction = { taskId: string; overlapsWith: string[]; confidence: number; reason?: string };`
  - `export function scopesOverlap(a: string[], b: string[]): boolean` — true if any path in `a` overlaps any in `b` by equality, directory/prefix containment, or glob match.
  - `export function scopeConfidence(task: PlanTask, planFileMap: string[]): number` — fraction of `task.fileScope` grounded in `planFileMap` (1 when `planFileMap` is empty ⇒ no penalty when no plan map exists).
  - `export function predictConflicts(tasks: PlanTask[], planFileMap: string[]): ConflictPrediction[]`.
  - `planParallelGroups(tasks, planFileMap?)` — new optional second arg; low-confidence (< 0.5) or overlapping tasks are sealed into singleton waves with a recorded reason. Signature stays backward compatible (omitted arg ⇒ today's behavior with confidence 1).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/conflict-prediction.test.ts
import { describe, it, expect } from "vitest";
import {
  scopesOverlap,
  scopeConfidence,
  predictConflicts,
} from "../plan-tasks.js";

const T = (id: string, fileScope: string[]): any => ({
  id,
  title: id,
  fileScope,
  dependsOn: [],
  parallelSafe: true,
});

describe("scopesOverlap", () => {
  it("flags directory/prefix containment", () => {
    expect(scopesOverlap(["src/foo/a.ts"], ["src/foo/"])).toBe(true);
  });
  it("flags glob overlap", () => {
    expect(scopesOverlap(["src/foo/*.ts"], ["src/foo/a.ts"])).toBe(true);
  });
  it("returns false for disjoint scopes", () => {
    expect(scopesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
  });
});

describe("scopeConfidence", () => {
  it("high when every scope path is in the plan map", () => {
    expect(
      scopeConfidence(T("t1", ["src/a.ts"]), ["src/a.ts", "src/b.ts"])
    ).toBe(1);
  });
  it("low when scope is ungrounded in the plan map", () => {
    expect(scopeConfidence(T("t1", ["src/ghost.ts"]), ["src/a.ts"])).toBe(0);
  });
  it("no penalty when no plan map exists", () => {
    expect(scopeConfidence(T("t1", ["src/a.ts"]), [])).toBe(1);
  });
});

describe("predictConflicts", () => {
  it("reports overlapping task ids and confidence", () => {
    const preds = predictConflicts(
      [T("t1", ["src/foo/a.ts"]), T("t2", ["src/foo/"])],
      ["src/foo/a.ts"]
    );
    expect(preds.find((p) => p.taskId === "t1")?.overlapsWith).toContain("t2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- conflict-prediction`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement overlap + confidence + prediction**

```ts
// in plan-tasks.ts
export type ConflictPrediction = {
  taskId: string;
  overlapsWith: string[];
  confidence: number;
  reason?: string;
};

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}
function pathsCollide(a: string, b: string): boolean {
  if (a === b) return true;
  const dir = (p: string) => (p.endsWith("/") ? p : `${p}/`);
  if (a.startsWith(dir(b)) || b.startsWith(dir(a))) return true;
  if (a.includes("*") && globToRegExp(a).test(b)) return true;
  if (b.includes("*") && globToRegExp(b).test(a)) return true;
  return false;
}
export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => pathsCollide(x, y)));
}
export function scopeConfidence(task: PlanTask, planFileMap: string[]): number {
  if (planFileMap.length === 0 || task.fileScope.length === 0) return 1;
  const grounded = task.fileScope.filter((f) =>
    planFileMap.some((m) => pathsCollide(f, m))
  );
  return grounded.length / task.fileScope.length;
}
export function predictConflicts(
  tasks: PlanTask[],
  planFileMap: string[]
): ConflictPrediction[] {
  return tasks.map((t) => {
    const overlapsWith = tasks
      .filter((o) => o.id !== t.id && scopesOverlap(t.fileScope, o.fileScope))
      .map((o) => o.id);
    const confidence = scopeConfidence(t, planFileMap);
    const reasons: string[] = [];
    if (overlapsWith.length)
      reasons.push(`file-scope overlaps ${overlapsWith.join(", ")}`);
    if (confidence < 0.5)
      reasons.push(
        `scope not grounded in plan map (confidence ${confidence.toFixed(2)})`
      );
    return {
      taskId: t.id,
      overlapsWith,
      confidence,
      reason: reasons.join("; ") || undefined,
    };
  });
}
```

Then update `planParallelGroups` to accept `planFileMap: string[] = []`, compute `predictConflicts` once, and when admitting a task to a wave also require `confidence >= 0.5` and no overlap with an already-claimed task — otherwise seal it as a singleton (reuse the existing singleton-sealing branch at `:154-156`). Keep the existing `usedScope` disjointness check but route it through `pathsCollide`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- conflict-prediction`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/plan-tasks.ts packages/core/src/index.ts packages/core/src/__tests__/conflict-prediction.test.ts
git commit -m "feat(fanout): overlap + plan-map conflict prediction (P25)"
```

---

### Task 2: Sub-agent handoff contract

**Files:**

- Create: `packages/core/src/handoff.ts`
- Modify: `packages/core/src/index.ts` (export)
- Modify: `packages/core/templates/subtask.md` (require the handoff artifact)
- Test: `packages/core/src/__tests__/handoff.test.ts`

**Interfaces:**

- Produces:
  - `export type TestRun = { command: string; passed: boolean };`
  - `export type SubAgentHandoff = { taskId: string; changedFiles: string[]; testsRun: TestRun[]; risks: string[]; deferred: string[]; outOfScopeFiles: string[] };`
  - `export function parseHandoff(raw: string, taskId: string, changedFilesFallback: string[]): SubAgentHandoff` — throws-free: valid JSON ⇒ normalized handoff; missing/garbage ⇒ minimal handoff from `changedFilesFallback`.
  - `export function computeOutOfScope(changedFiles: string[], fileScope: string[]): string[]` — changed files not covered by any `fileScope` entry (reuse `pathsCollide` from Task 1 via import).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/handoff.test.ts
import { describe, it, expect } from "vitest";
import { parseHandoff, computeOutOfScope } from "../handoff.js";

describe("computeOutOfScope", () => {
  it("flags a changed file outside declared scope", () => {
    expect(
      computeOutOfScope(["src/a.ts", "src/other.ts"], ["src/a.ts"])
    ).toEqual(["src/other.ts"]);
  });
  it("respects directory scope", () => {
    expect(computeOutOfScope(["src/foo/a.ts"], ["src/foo/"])).toEqual([]);
  });
});

describe("parseHandoff", () => {
  it("normalizes valid JSON", () => {
    const h = parseHandoff(
      JSON.stringify({
        changedFiles: ["src/a.ts"],
        testsRun: [{ command: "pnpm test", passed: true }],
        risks: ["r"],
        deferred: [],
      }),
      "t1",
      []
    );
    expect(h.taskId).toBe("t1");
    expect(h.testsRun[0].passed).toBe(true);
  });
  it("derives a minimal handoff from the diff fallback on garbage", () => {
    const h = parseHandoff("not json", "t1", ["src/a.ts"]);
    expect(h.changedFiles).toEqual(["src/a.ts"]);
    expect(h.testsRun).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- handoff`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handoff module**

```ts
// packages/core/src/handoff.ts
import { pathsCollide } from "./plan-tasks.js"; // export pathsCollide from Task 1

export type TestRun = { command: string; passed: boolean };
export type SubAgentHandoff = {
  taskId: string;
  changedFiles: string[];
  testsRun: TestRun[];
  risks: string[];
  deferred: string[];
  outOfScopeFiles: string[];
};

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

export function computeOutOfScope(
  changedFiles: string[],
  fileScope: string[]
): string[] {
  if (fileScope.length === 0) return [];
  return changedFiles.filter((f) => !fileScope.some((s) => pathsCollide(f, s)));
}

export function parseHandoff(
  raw: string,
  taskId: string,
  changedFilesFallback: string[]
): SubAgentHandoff {
  const minimal: SubAgentHandoff = {
    taskId,
    changedFiles: changedFilesFallback,
    testsRun: [],
    risks: [],
    deferred: [],
    outOfScopeFiles: [],
  };
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return minimal;
  }
  if (!obj || typeof obj !== "object") return minimal;
  const changedFiles = strArr(obj.changedFiles).length
    ? strArr(obj.changedFiles)
    : changedFilesFallback;
  const testsRun: TestRun[] = Array.isArray(obj.testsRun)
    ? obj.testsRun
        .filter((t: any) => t && typeof t.command === "string")
        .map((t: any) => ({ command: t.command, passed: t.passed === true }))
    : [];
  return {
    taskId,
    changedFiles,
    testsRun,
    risks: strArr(obj.risks),
    deferred: strArr(obj.deferred),
    outOfScopeFiles: strArr(obj.outOfScopeFiles),
  };
}
```

Requires exporting `pathsCollide` from `plan-tasks.ts` (add `export` in Task 1's implementation if not already; note it here so the T1 implementer exports it).

- [ ] **Step 4: Update the sub-task template**

In `packages/core/templates/subtask.md`, append an instruction: after implementing and running tests, write `handoff.json` at the worktree root with keys `changedFiles`, `testsRun` (`{command, passed}`), `risks`, `deferred`. Keep it terse and mandatory.

- [ ] **Step 5: Run test + commit**

Run: `pnpm --filter @phamvuhoang/otto-core test -- handoff`
Expected: PASS.

```bash
pnpm -r typecheck
git add packages/core/src/handoff.ts packages/core/src/index.ts packages/core/templates/subtask.md packages/core/src/__tests__/handoff.test.ts
git commit -m "feat(fanout): sub-agent handoff contract + out-of-scope diff (P25)"
```

---

### Task 3: Conflict-aware synthesizer — merge ordering, defer reasons, cross-task summary

**Files:**

- Modify: `packages/core/src/fanout.ts` (Phase B serial merge at `:152-173`; `FanoutTaskOutcome`/`FanoutResult` at `:20-32`; `Built` at `:108-115`)
- Test: `packages/core/src/__tests__/synthesizer.test.ts`

**Interfaces:**

- Consumes: `ConflictPrediction`, `predictConflicts` (Task 1); `SubAgentHandoff`, `parseHandoff` (Task 2).
- Produces:
  - `FanoutTaskOutcome` gains `handoff?: SubAgentHandoff`.
  - `FanoutResult` gains `crossTaskSummary: string`.
  - `export function orderByConflictRisk(tasks: PlanTask[], predictions: ConflictPrediction[]): PlanTask[]` — highest confidence + fewest overlaps first.
  - `export function buildCrossTaskSummary(outcomes: FanoutTaskOutcome[]): string` — lists shared-file touches, out-of-scope touches, and deferrals; `""` when nothing noteworthy.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/synthesizer.test.ts
import { describe, it, expect } from "vitest";
import { orderByConflictRisk, buildCrossTaskSummary } from "../fanout.js";

const T = (id: string, fileScope: string[]): any => ({
  id,
  title: id,
  fileScope,
  dependsOn: [],
  parallelSafe: true,
});

describe("orderByConflictRisk", () => {
  it("puts the highest-confidence, lowest-overlap task first", () => {
    const tasks = [T("risky", ["src/foo/"]), T("safe", ["src/z.ts"])];
    const preds = [
      { taskId: "risky", overlapsWith: ["safe"], confidence: 0.2 },
      { taskId: "safe", overlapsWith: [], confidence: 1 },
    ];
    expect(orderByConflictRisk(tasks, preds).map((t) => t.id)).toEqual([
      "safe",
      "risky",
    ]);
  });
});

describe("buildCrossTaskSummary", () => {
  it("summarizes out-of-scope touches and deferrals", () => {
    const s = buildCrossTaskSummary([
      {
        task: T("t1", ["src/a.ts"]),
        status: "landed",
        handoff: {
          taskId: "t1",
          changedFiles: ["src/a.ts", "src/x.ts"],
          testsRun: [],
          risks: [],
          deferred: [],
          outOfScopeFiles: ["src/x.ts"],
        },
      } as any,
      {
        task: T("t2", ["src/b.ts"]),
        status: "deferred",
        reason: "cherry-pick conflict",
      } as any,
    ]);
    expect(s).toContain("src/x.ts");
    expect(s).toContain("cherry-pick conflict");
  });
  it("returns empty when nothing noteworthy", () => {
    expect(
      buildCrossTaskSummary([
        { task: T("t1", ["src/a.ts"]), status: "landed" } as any,
      ])
    ).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- synthesizer`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement ordering + summary + wire into Phase B**

```ts
// in fanout.ts
export function orderByConflictRisk(
  tasks: PlanTask[],
  predictions: ConflictPrediction[]
): PlanTask[] {
  const score = (id: string) => {
    const p = predictions.find((x) => x.taskId === id);
    return p ? p.confidence - p.overlapsWith.length : 1;
  };
  return [...tasks].sort((a, b) => score(b.id) - score(a.id));
}

export function buildCrossTaskSummary(outcomes: FanoutTaskOutcome[]): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    const oos = o.handoff?.outOfScopeFiles ?? [];
    if (oos.length)
      lines.push(`- ${o.task.id} touched out-of-scope: ${oos.join(", ")}`);
    if (o.status === "deferred")
      lines.push(`- ${o.task.id} deferred: ${o.reason ?? "unknown"}`);
  }
  return lines.length ? `Cross-task interactions:\n${lines.join("\n")}` : "";
}
```

In Phase B: before the merge loop, compute `predictConflicts` and reorder the built worktrees via `orderByConflictRisk` (lowest-conflict first). When reading each built worktree, read its `handoff.json` (via `parseHandoff` with the git-diff file list as fallback) and attach it to the outcome. Keep the existing cherry-pick + abort-on-conflict logic; enrich the deferred `reason` with handoff risks when present. After the loop, set `result.crossTaskSummary = buildCrossTaskSummary(outcomes)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- synthesizer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/fanout.ts packages/core/src/__tests__/synthesizer.test.ts
git commit -m "feat(fanout): conflict-aware merge ordering + cross-task summary (P25)"
```

---

### Task 4: Evidence — sub-agent stage records + manifest field + outcome enrichment

**Files:**

- Modify: `packages/core/src/run-report.ts` (`RunManifest` at `:153-197`)
- Modify: `packages/core/src/loop.ts` (fan-out result handling at `:1151-1156`; `recordStage` closure at `:564-609`)
- Test: `packages/core/src/__tests__/fanout-evidence.test.ts`

**Interfaces:**

- Consumes: `FanoutResult`, `FanoutTaskOutcome` (Task 3); `writeStageRecord` / `StageRecord` (`run-report.ts`).
- Produces:
  - `RunManifest.fanout?: { contributions: { taskId: string; status: string; changedFiles: string[]; reason?: string }[]; crossTaskSummary: string }`.
  - `export function summarizeFanout(result: FanoutResult): NonNullable<RunManifest["fanout"]>` — pure mapper from a `FanoutResult` to the manifest field.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/fanout-evidence.test.ts
import { describe, it, expect } from "vitest";
import { summarizeFanout } from "../run-report.js";

const T = (id: string): any => ({
  id,
  title: id,
  fileScope: [],
  dependsOn: [],
  parallelSafe: true,
});

describe("summarizeFanout", () => {
  it("maps outcomes to contributions with status and reason", () => {
    const out = summarizeFanout({
      outcomes: [
        {
          task: T("t1"),
          status: "landed",
          handoff: {
            taskId: "t1",
            changedFiles: ["src/a.ts"],
            testsRun: [],
            risks: [],
            deferred: [],
            outOfScopeFiles: [],
          },
        },
        { task: T("t2"), status: "deferred", reason: "cherry-pick conflict" },
      ],
      deferred: [T("t2")],
      crossTaskSummary:
        "Cross-task interactions:\n- t2 deferred: cherry-pick conflict",
    } as any);
    expect(out.contributions).toHaveLength(2);
    expect(out.contributions[0]).toMatchObject({
      taskId: "t1",
      status: "landed",
      changedFiles: ["src/a.ts"],
    });
    expect(out.contributions[1]).toMatchObject({
      taskId: "t2",
      status: "deferred",
      reason: "cherry-pick conflict",
    });
    expect(out.crossTaskSummary).toContain("cherry-pick conflict");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- fanout-evidence`
Expected: FAIL — `summarizeFanout` not exported.

- [ ] **Step 3: Add the manifest field + mapper, wire into the loop**

```ts
// in run-report.ts
export function summarizeFanout(result: FanoutResult) {
  return {
    contributions: result.outcomes.map((o) => ({
      taskId: o.task.id,
      status: o.status,
      changedFiles: o.handoff?.changedFiles ?? [],
      reason: o.reason,
    })),
    crossTaskSummary: result.crossTaskSummary,
  };
}
```

Add the optional `fanout` field to `RunManifest` (mirror the `inputSharpness` optional pattern). In `loop.ts`, after `runFanout(...)` resolves (`:1151`), call `summarizeFanout(result)` and store it on the manifest builder; additionally write one `StageRecord` per outcome via the `recordStage` closure so each sub-agent gets an inspectable record (stage name e.g. `subImplementer:${task.id}`), replacing today's stderr-only logging.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- fanout-evidence`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/run-report.ts packages/core/src/loop.ts packages/core/src/__tests__/fanout-evidence.test.ts
git commit -m "feat(fanout): per-agent + defer-reason evidence in manifest & stage records (P25)"
```

---

### Task 5: Report — "Agent contributions" section

**Files:**

- Modify: `packages/core/src/report-finalize.ts` (`finalizeReportText` at `:346-360`; `FinalizeReportContext` type)
- Test: `packages/core/src/__tests__/report-agent-contributions.test.ts`

**Interfaces:**

- Consumes: the `RunManifest["fanout"]` shape (Task 4).
- Produces:
  - `FinalizeReportContext` gains `fanout?: RunManifest["fanout"]`.
  - `export function formatAgentContributions(fanout: NonNullable<RunManifest["fanout"]>): string` — a markdown section; `""` when there are no contributions.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/report-agent-contributions.test.ts
import { describe, it, expect } from "vitest";
import { formatAgentContributions } from "../report-finalize.js";

describe("formatAgentContributions", () => {
  it("lists each agent and every defer reason", () => {
    const md = formatAgentContributions({
      contributions: [
        { taskId: "t1", status: "landed", changedFiles: ["src/a.ts"] },
        {
          taskId: "t2",
          status: "deferred",
          changedFiles: [],
          reason: "cherry-pick conflict",
        },
      ],
      crossTaskSummary:
        "Cross-task interactions:\n- t2 deferred: cherry-pick conflict",
    });
    expect(md).toContain("t1");
    expect(md).toContain("landed");
    expect(md).toContain("cherry-pick conflict");
  });
  it("empty when no contributions", () => {
    expect(
      formatAgentContributions({ contributions: [], crossTaskSummary: "" })
    ).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- report-agent-contributions`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement + wire into `finalizeReportText`**

```ts
// in report-finalize.ts
export function formatAgentContributions(
  fanout: NonNullable<FinalizeReportContext["fanout"]>
): string {
  if (!fanout.contributions.length) return "";
  const rows = fanout.contributions
    .map(
      (c) =>
        `- **${c.taskId}** — ${c.status}${c.changedFiles.length ? ` (${c.changedFiles.join(", ")})` : ""}${c.reason ? ` — ${c.reason}` : ""}`
    )
    .join("\n");
  const summary = fanout.crossTaskSummary
    ? `\n\n${fanout.crossTaskSummary}`
    : "";
  return `## Agent contributions\n\n${rows}${summary}`;
}
```

Add `fanout?` to `FinalizeReportContext`, and append `formatAgentContributions(ctx.fanout)` (when present) inside `finalizeReportText` alongside `appendAutomatedEvidence`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- report-agent-contributions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/report-finalize.ts packages/core/src/__tests__/report-agent-contributions.test.ts
git commit -m "feat(report): agent contributions + defer reasons section (P25)"
```

---

### Task 6: Panel — cross-task summary injection + lens routing binding

**Files:**

- Modify: `packages/core/src/panel.ts` (`RunPanelOptions` at `:139-183`; lens phase start at `:258`)
- Modify: `packages/core/src/loop.ts` (panel invocation at `:1244-1268` — pass the summary through)
- Test: `packages/core/src/__tests__/panel-cross-task.test.ts`

**Interfaces:**

- Consumes: `crossTaskSummary` from `FanoutResult` (Task 3); existing `routedLenses`/`routeReview`.
- Produces:
  - `RunPanelOptions` gains `crossTaskSummary?: string`.
  - `export function formatCrossTaskBlock(summary: string | undefined): string` — a bounded injected block (analogous to `formatSharpeningGuidance`); `""` when no summary.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/panel-cross-task.test.ts
import { describe, it, expect } from "vitest";
import { formatCrossTaskBlock } from "../panel.js";

describe("formatCrossTaskBlock", () => {
  it("wraps a non-empty summary in a bounded block", () => {
    const b = formatCrossTaskBlock(
      "Cross-task interactions:\n- t2 deferred: conflict"
    );
    expect(b).toContain("t2 deferred");
    expect(b.length).toBeGreaterThan(0);
  });
  it("empty when no summary", () => {
    expect(formatCrossTaskBlock(undefined)).toBe("");
    expect(formatCrossTaskBlock("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- panel-cross-task`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the block + thread it into lens/verify vars**

```ts
// in panel.ts
export function formatCrossTaskBlock(summary: string | undefined): string {
  if (!summary) return "";
  return `<cross-task-summary>\nThe implementation ran in parallel. Review these interactions:\n${summary}\n</cross-task-summary>`;
}
```

Add `crossTaskSummary?` to `RunPanelOptions`; at the lens phase start compute `const xtask = formatCrossTaskBlock(opts.crossTaskSummary)` and include it in the lens (`:274`) and verify (`:346`) prompt vars (e.g. a new `CROSS_TASK` var referenced by the templates, or prepend to `RESUME`). In `loop.ts`, pass `crossTaskSummary: fanoutResult?.crossTaskSummary` into the panel options. Leave lens routing as-is except: when `crossTaskSummary` mentions out-of-scope touches, ensure the `structural` lens is included (append to the routed set).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- panel-cross-task`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/panel.ts packages/core/src/loop.ts packages/core/src/__tests__/panel-cross-task.test.ts
git commit -m "feat(panel): inject cross-task interaction summary before review (P25)"
```

---

### Task 7: Optional P26 worktree retrieval-identity binding (inert by default)

**Files:**

- Modify: `packages/core/src/fanout.ts` (`RunFanoutOptions` at `:34-56`; `Built` at `:108-115`; `defaultRunSubAgent` at `:78-105`)
- Modify: `packages/core/src/loop.ts` (thread `retrievalStore` into `runFanout` at `:1137-1150`)
- Test: `packages/core/src/__tests__/fanout-retrieval-binding.test.ts`

**Interfaces:**

- Consumes: `RetrievalStore` from `runRetrievalStore` (`context-compressor.ts`, created at `loop.ts:550`); `CbmIndexIdentity` (P26 Task 3) — imported type-only so P25 does not hard-depend on P26 being enabled.
- Produces:
  - `RunFanoutOptions` gains `retrievalStore?` (passed through to sub-agent `executeStage` as today's `retrievalStore` param) and `bindWorktreeIdentity?: boolean` (default false ⇒ inert).
  - `export function worktreeIndexIdentity(dir: string, before: string): { workspace: string; sourceRevision: string; worktreeDirty: boolean }` — per-worktree identity used only when binding is on.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/fanout-retrieval-binding.test.ts
import { describe, it, expect } from "vitest";
import { worktreeIndexIdentity } from "../fanout.js";

describe("worktreeIndexIdentity", () => {
  it("reports the worktree dir as workspace and the before-SHA as revision", () => {
    const id = worktreeIndexIdentity("/repo/.otto-tmp/wt/1-t1", "abc123");
    expect(id.workspace).toBe("/repo/.otto-tmp/wt/1-t1");
    expect(id.sourceRevision).toBe("abc123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- fanout-retrieval-binding`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement identity + thread retrievalStore (guarded)**

```ts
// in fanout.ts
export function worktreeIndexIdentity(dir: string, before: string) {
  return { workspace: dir, sourceRevision: before, worktreeDirty: false };
}
```

Add `retrievalStore?` and `bindWorktreeIdentity?` to `RunFanoutOptions`. In `defaultRunSubAgent`, when `opts.retrievalStore` is set, pass it into the `executeStage` call (matching the param `stage-exec.ts` already accepts). When `opts.bindWorktreeIdentity` is true, compute `worktreeIndexIdentity(dir, before)` and attach it to `Built` so a per-worktree identity exists (only consumed when P26 is active). Default path (both unset) is byte-for-byte today's behavior. In `loop.ts`, pass `retrievalStore` into `runFanout` and set `bindWorktreeIdentity` only when the `codebase-memory` tool is enabled for the run.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- fanout-retrieval-binding`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/fanout.ts packages/core/src/loop.ts packages/core/src/__tests__/fanout-retrieval-binding.test.ts
git commit -m "feat(fanout): optional per-worktree retrieval identity binding (P25/P26)"
```

---

### Task 8: Fan-out A/B eval config + docs + full verify

**Files:**

- Modify: `benchmarks/configs.json` (add a `fanout-hardened` config)
- Modify: `benchmarks/suite.json` (add/confirm a disjoint-task and an overlapping-task fixture)
- Create: `benchmarks/fixtures/fanout-overlap/` (two tasks with overlapping scope + a `tasks.json`; expect one deferral)
- Modify: `README.md`, `docs/HARNESS_ROADMAP_PHASE5.md` (status line for P25)

**Interfaces:** none (config + docs).

- [ ] **Step 1: Add the eval config + fixture**

`benchmarks/configs.json` — append `{ "label": "fanout-hardened", "args": ["--fan-out"], "env": {} }`. Create `benchmarks/fixtures/fanout-overlap/` with a `.otto/tasks/<key>/tasks.json` containing two `parallelSafe` tasks whose `fileScope` overlaps by directory, a `README.md`, and a benchmark `check` asserting exactly one task lands and one is deferred with a recorded reason (inspect the manifest `fanout.contributions`).

- [ ] **Step 2: Document the feature**

Add a "Multi-agent coordination (P25)" note to `README.md` (fan-out now predicts conflicts, requires handoffs, and reports per-agent contributions/deferrals) and update the `docs/HARNESS_ROADMAP_PHASE5.md` status line to note P25 has landed.

- [ ] **Step 3: Full verify**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/configs.json benchmarks/suite.json benchmarks/fixtures/fanout-overlap README.md docs/HARNESS_ROADMAP_PHASE5.md
git commit -m "test(fanout): A/B config + overlap fixture + docs (P25)"
```

---

## Self-Review Notes

- **Spec coverage:** conflict prediction (T1), handoff contract (T2), synthesizer/merge-order/cross-task summary (T3), evidence — records+manifest+outcome (T4), report section (T5), panel injection + lens binding (T6), optional P26 worktree binding (T7), eval config + fixtures + docs (T8). All eight spec scope bullets + all seven success criteria map to a task.
- **Placeholder scan:** every code step has concrete code; every test step has real assertions; commands have expected output. No TBD/TODO.
- **Type consistency:** `pathsCollide` defined and **exported** in T1, imported by T2 and reused for `computeOutOfScope`; `ConflictPrediction`/`predictConflicts` (T1) consumed in T3; `SubAgentHandoff`/`parseHandoff` (T2) consumed in T3; `FanoutResult.crossTaskSummary` + `FanoutTaskOutcome.handoff` (T3) consumed in T4; `RunManifest["fanout"]` (T4) consumed in T5; `RetrievalStore`/`CbmIndexIdentity` (T7) imported type-only so P25 stays independent of P26 being enabled.
- **Cross-plan dependency:** T7 references P26's `CbmIndexIdentity` (type-only) and the `codebase-memory` tool being enabled — inert unless the P26 plan has landed. P25 T1–T6, T8 have no P26 dependency.
