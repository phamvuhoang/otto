# P26 Slice 2 — Codebase Memory Production Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the P26 spike primitives into a working, off-by-default retrieval path: Otto builds/refreshes a confined local code graph and injects bounded structural results into plan/implement/review/verify — while graph output stays navigation-only, writes stay confined, and any degradation falls back to today's behavior.

**Architecture:** Three focused units — transport (`codebase-memory-adapter.ts`, exists), confined indexing + freshness (`cbm-index.ts`, new), and per-stage query + injection (`cbm-inject.ts`, new) — wired into `loop.ts` behind the existing tool-enablement gate. Injection uses the existing `stage-exec` `injectedContext` seam and P22 `runRetrievalStore` lifecycle. All logic is unit-tested with a stub `CbmRunner`; real transport + the A/B benchmark stay gated on `OTTO_CBM_E2E=1`.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥20, vitest. `packages/core` only. No new npm dependencies.

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **No new npm dependencies.**
- **Off by default / opt-in.** A bare run — or one where the `codebase-memory` tool is not enabled for a stage — is byte-for-byte unchanged. Enablement = profile + config `stages`; the operator turns injection on after benchmark evidence. No default-on, no "production-ready" code flag.
- **Graph is never authoritative.** Output is navigation evidence; current source reads and tests remain the completion gate.
- **No hidden index writes.** Confinement enforced by `diffWriteInventory`; any escape aborts the index and falls back.
- **No silent stale use.** A non-`fresh` index yields no injection + a recorded `fallbackReason`.
- **Excluded ops stay blocked** (`delete_project`, `manage_adr`, `ingest_traces`, graph UI, shared artifacts); no agent-driven MCP exposure; no upstream install/update; no personal-config mutation.
- **Verify:** `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit runs prettier + typecheck. Never hand-edit release version state.

## File Structure

- Create `packages/core/src/cbm-index.ts` — confined indexing (`runIndexRepository`) + freshness decisions (`decideIndexAction`, `canInject`).
- Create `packages/core/src/cbm-inject.ts` — per-stage query map (`stageQueries`) + injection builder (`buildCbmInjection`) + the `<graph-map>` block.
- Modify `packages/core/src/context-report.ts` — classify `<graph-map>` as `evidence` (→ `retrievable`).
- Modify `packages/core/src/loop.ts` — preflight (re)index, refresh-before-review, per-stage injection wiring, all gated on tool enablement.
- Modify `packages/core/src/index.ts` — export new symbols.
- Modify `packages/core/templates/prompt.md` (+ stage templates as needed) — source-before-edit instruction.
- Modify `benchmarks/configs.json` + add `benchmarks/fixtures/cbm-*` — eval.

---

### Task 1: Confined indexing (`cbm-index.ts` — `runIndexRepository`)

**Files:**

- Create: `packages/core/src/cbm-index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/cbm-index.test.ts`

**Interfaces:**

- Consumes: `CbmRunner`, `CbmIndexIdentity`, `WriteInventory`, `diffWriteInventory` (from `./codebase-memory-adapter.js`).
- Produces:
  - `export type IndexResult = { ok: boolean; identity?: CbmIndexIdentity; fallbackReason?: string; writeInventory: WriteInventory };`
  - `export type IndexInputs = { runner: CbmRunner; scratchDir: string; declaredRoots: string[]; snapshot: (dir: string) => string[]; identity: Omit<CbmIndexIdentity, "indexStatus">; };`
  - `export function runIndexRepository(inputs: IndexInputs): IndexResult` — snapshots `scratchDir` before, calls `runner.call({ operation: "index_repository", params: { cacheDir: scratchDir } })`, snapshots after, runs `diffWriteInventory`; **any escaped write ⇒ `{ ok: false, fallbackReason }`** (index not trusted); a failed runner call ⇒ `{ ok: false, fallbackReason }`; else `{ ok: true, identity: {...indexStatus:"ready"} }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/cbm-index.test.ts
import { describe, it, expect } from "vitest";
import { runIndexRepository, type IndexInputs } from "../cbm-index.js";
import type { CbmRunner } from "../codebase-memory-adapter.js";

const okRunner: CbmRunner = {
  available: () => true,
  call: () => ({ ok: true, result: { status: "ready" } }),
};
const identity = {
  workspace: "/repo",
  sourceRevision: "abc123",
  worktreeDirty: false,
  toolVersion: "1.0.0",
  indexedAt: "2026-07-17T00:00:00Z",
};

function inputs(over: Partial<IndexInputs> = {}): IndexInputs {
  const files = [".otto/cbm-scratch/.codebase-memory/graph.db.zst"];
  return {
    runner: okRunner,
    scratchDir: ".otto/cbm-scratch",
    declaredRoots: [".otto/cbm-scratch"],
    // before: empty; after: only in-scratch writes
    snapshot: (() => {
      let n = 0;
      return () => (n++ === 0 ? [] : files);
    })(),
    identity,
    ...over,
  };
}

describe("runIndexRepository", () => {
  it("succeeds and records identity when all writes stay in scratch", () => {
    const r = runIndexRepository(inputs());
    expect(r.ok).toBe(true);
    expect(r.identity?.indexStatus).toBe("ready");
    expect(r.writeInventory.escaped).toEqual([]);
  });

  it("aborts when a write escapes the scratch dir", () => {
    const r = runIndexRepository(
      inputs({
        snapshot: (() => {
          let n = 0;
          return () => (n++ === 0 ? [] : [".gitattributes"]);
        })(),
      })
    );
    expect(r.ok).toBe(false);
    expect(r.fallbackReason).toMatch(/escap/i);
    expect(r.identity).toBeUndefined();
  });

  it("aborts when the runner call fails", () => {
    const r = runIndexRepository(
      inputs({
        runner: {
          available: () => true,
          call: () => ({ ok: false, error: "boom" }),
        },
      })
    );
    expect(r.ok).toBe(false);
    expect(r.fallbackReason).toMatch(/boom|index/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-index`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runIndexRepository`**

```ts
// packages/core/src/cbm-index.ts
import {
  diffWriteInventory,
  type CbmIndexIdentity,
  type CbmRunner,
  type WriteInventory,
} from "./codebase-memory-adapter.js";

export type IndexResult = {
  ok: boolean;
  identity?: CbmIndexIdentity;
  fallbackReason?: string;
  writeInventory: WriteInventory;
};

export type IndexInputs = {
  runner: CbmRunner;
  scratchDir: string;
  declaredRoots: string[];
  snapshot: (dir: string) => string[];
  identity: Omit<CbmIndexIdentity, "indexStatus">;
};

const EMPTY_INVENTORY: WriteInventory = { files: [], escaped: [] };

/**
 * Run `index_repository` confined to `scratchDir`, then verify no write escaped
 * the declared roots. Any escape (or a failed call) aborts: the index is not
 * trusted and the caller falls back to normal search. Pure w.r.t. its injected
 * `snapshot`/`runner` — the loop supplies fs-backed impls.
 */
export function runIndexRepository(inputs: IndexInputs): IndexResult {
  const before = inputs.snapshot(inputs.scratchDir);
  const res = inputs.runner.call({
    operation: "index_repository",
    params: { cacheDir: inputs.scratchDir },
  });
  if (!res.ok) {
    return {
      ok: false,
      fallbackReason: `index_repository failed: ${res.error ?? "unknown"}`,
      writeInventory: EMPTY_INVENTORY,
    };
  }
  const after = inputs.snapshot(inputs.scratchDir);
  const inventory = diffWriteInventory(before, after, inputs.declaredRoots);
  if (inventory.escaped.length > 0) {
    return {
      ok: false,
      fallbackReason: `index writes escaped confinement: ${inventory.escaped.join(", ")}`,
      writeInventory: inventory,
    };
  }
  return {
    ok: true,
    identity: { ...inputs.identity, indexStatus: "ready" },
    writeInventory: inventory,
  };
}
```

Export `runIndexRepository`, `IndexResult`, `IndexInputs` from `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-index`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/cbm-index.ts packages/core/src/index.ts packages/core/src/__tests__/cbm-index.test.ts
git commit -m "feat(cbm): confined index_repository with write-inventory abort (P26 slice2)"
```

---

### Task 2: Freshness decisions (`cbm-index.ts` — `decideIndexAction` + `canInject`)

**Files:**

- Modify: `packages/core/src/cbm-index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/cbm-freshness-decision.test.ts`

**Interfaces:**

- Consumes: `classifyIndexFreshness`, `IndexFreshness`, `CbmIndexIdentity` (from `./codebase-memory-adapter.js`).
- Produces:
  - `export type IndexAction = { action: "reuse" | "reindex"; freshness: IndexFreshness; reason: string };`
  - `export function decideIndexAction(current, persisted): IndexAction` — `fresh` ⇒ reuse; `absent|stale|wrong-project` ⇒ reindex, `reason` = the freshness verdict.
  - `export function canInject(freshness: IndexFreshness): { inject: boolean; fallbackReason?: string }` — inject only when `fresh`; otherwise `{ inject: false, fallbackReason: "index <freshness>" }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/cbm-freshness-decision.test.ts
import { describe, it, expect } from "vitest";
import { decideIndexAction, canInject } from "../cbm-index.js";
import type { CbmIndexIdentity } from "../codebase-memory-adapter.js";

const idx: CbmIndexIdentity = {
  workspace: "/repo",
  sourceRevision: "abc123",
  worktreeDirty: false,
  toolVersion: "1.0.0",
  indexStatus: "ready",
  indexedAt: "t",
};
const here = {
  workspace: "/repo",
  sourceRevision: "abc123",
  worktreeDirty: false,
};

describe("decideIndexAction", () => {
  it("reuses a fresh index", () => {
    expect(decideIndexAction(here, idx)).toMatchObject({
      action: "reuse",
      freshness: "fresh",
    });
  });
  it("reindexes when absent", () => {
    expect(decideIndexAction(here, null)).toMatchObject({
      action: "reindex",
      freshness: "absent",
    });
  });
  it("reindexes on revision drift (stale)", () => {
    expect(
      decideIndexAction({ ...here, sourceRevision: "def" }, idx)
    ).toMatchObject({ action: "reindex", freshness: "stale" });
  });
});

describe("canInject", () => {
  it("allows injection only when fresh", () => {
    expect(canInject("fresh")).toEqual({ inject: true });
  });
  it("blocks injection with a reason otherwise", () => {
    expect(canInject("stale").inject).toBe(false);
    expect(canInject("stale").fallbackReason).toMatch(/stale/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-freshness-decision`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

```ts
// append to packages/core/src/cbm-index.ts
import {
  classifyIndexFreshness,
  type IndexFreshness,
} from "./codebase-memory-adapter.js";

export type IndexAction = {
  action: "reuse" | "reindex";
  freshness: IndexFreshness;
  reason: string;
};

export function decideIndexAction(
  current: {
    workspace: string;
    sourceRevision: string;
    worktreeDirty: boolean;
  } | null,
  persisted: CbmIndexIdentity | null
): IndexAction {
  const freshness = classifyIndexFreshness(current, persisted);
  return freshness === "fresh"
    ? { action: "reuse", freshness, reason: "index fresh" }
    : { action: "reindex", freshness, reason: `index ${freshness}` };
}

export function canInject(freshness: IndexFreshness): {
  inject: boolean;
  fallbackReason?: string;
} {
  return freshness === "fresh"
    ? { inject: true }
    : { inject: false, fallbackReason: `index ${freshness}` };
}
```

(Adjust the existing `import type { CbmIndexIdentity, ... }` at the top of `cbm-index.ts` to also import `classifyIndexFreshness` + `IndexFreshness`.) Export `decideIndexAction`, `canInject`, `IndexAction` from `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-freshness-decision`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/cbm-index.ts packages/core/src/index.ts packages/core/src/__tests__/cbm-freshness-decision.test.ts
git commit -m "feat(cbm): index reuse/reindex + inject-only-when-fresh decisions (P26 slice2)"
```

---

### Task 3: Per-stage query map + injection builder (`cbm-inject.ts`)

**Files:**

- Create: `packages/core/src/cbm-inject.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/cbm-inject.test.ts`

**Interfaces:**

- Consumes: `CbmRunner`, `CbmRequest`, `IndexFreshness` (from `./codebase-memory-adapter.js`); `canInject` (Task 2); `RetrievalStore` (from `./context-compressor.js`); `ToolUsage` (from `./run-report.js`).
- Produces:
  - `export const GRAPH_BLOCK_TAG = "graph-map";`
  - `export function stageQueries(stage: string, ctx: { changedFiles?: string[]; taskHint?: string }): CbmRequest[]` — `plan` ⇒ `[get_architecture]`; `implementer` ⇒ `[search_graph]` (params from `taskHint`); `reviewer`/`verifier` ⇒ `[detect_changes, trace_path]` over `changedFiles`; unknown ⇒ `[]`.
  - `export type CbmInjection = { block: string; toolUsage: ToolUsage };`
  - `export function buildCbmInjection(opts: { stage: string; requests: CbmRequest[]; runner: CbmRunner; freshness: IndexFreshness; maxChars: number; store?: RetrievalStore | null; }): CbmInjection` — non-fresh ⇒ empty block + `fallbackReason`; any failed call ⇒ empty block + `fallbackReason`; else concatenate results, bound to `maxChars`, wrap in a `<graph-map>` block with the navigation-only header; store the full (unbounded) result via `store` → `retrievalHandle`. Always returns a `ToolUsage { name: "codebase-memory", kind: "mcp", stage, query, indexFreshness, resultSize, retrievalHandle?, fallbackReason? }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/cbm-inject.test.ts
import { describe, it, expect } from "vitest";
import {
  stageQueries,
  buildCbmInjection,
  GRAPH_BLOCK_TAG,
} from "../cbm-inject.js";
import type { CbmRunner } from "../codebase-memory-adapter.js";

const runner = (text: string): CbmRunner => ({
  available: () => true,
  call: () => ({ ok: true, result: text }),
});

describe("stageQueries", () => {
  it("asks for architecture on plan", () => {
    expect(stageQueries("plan", {}).map((r) => r.operation)).toEqual([
      "get_architecture",
    ]);
  });
  it("asks for change-impact on reviewer", () => {
    expect(
      stageQueries("reviewer", { changedFiles: ["src/a.ts"] }).map(
        (r) => r.operation
      )
    ).toEqual(["detect_changes", "trace_path"]);
  });
  it("returns nothing for an unknown stage", () => {
    expect(stageQueries("journalWrite", {})).toEqual([]);
  });
});

describe("buildCbmInjection", () => {
  const base = {
    stage: "plan",
    requests: [{ operation: "get_architecture", params: {} }],
    maxChars: 50,
  };

  it("injects a bounded navigation-only block when fresh", () => {
    const inj = buildCbmInjection({
      ...base,
      runner: runner("A".repeat(500)),
      freshness: "fresh",
    });
    expect(inj.block).toContain(`<${GRAPH_BLOCK_TAG}>`);
    expect(inj.block).toMatch(/read the actual source/i);
    expect(inj.block.length).toBeLessThan(200); // header + bounded 50-char body
    expect(inj.toolUsage.indexFreshness).toBe("fresh");
  });

  it("stores the full result and keeps a retrieval handle", () => {
    let stored = "";
    const store = (_k: string, original: string) => {
      stored = original;
      return ".otto/runs/r/compressed/graph-map.orig";
    };
    const inj = buildCbmInjection({
      ...base,
      runner: runner("FULL-RESULT"),
      freshness: "fresh",
      store,
    });
    expect(stored).toContain("FULL-RESULT");
    expect(inj.toolUsage.retrievalHandle).toContain("graph-map");
  });

  it("emits no block and a fallback reason when the index is not fresh", () => {
    const inj = buildCbmInjection({
      ...base,
      runner: runner("x"),
      freshness: "stale",
    });
    expect(inj.block).toBe("");
    expect(inj.toolUsage.fallbackReason).toMatch(/stale/);
  });

  it("emits no block and a fallback reason when a query fails", () => {
    const failing: CbmRunner = {
      available: () => true,
      call: () => ({ ok: false, error: "down" }),
    };
    const inj = buildCbmInjection({
      ...base,
      runner: failing,
      freshness: "fresh",
    });
    expect(inj.block).toBe("");
    expect(inj.toolUsage.fallbackReason).toMatch(/down|query/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-inject`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/cbm-inject.ts
import type {
  CbmRequest,
  CbmRunner,
  IndexFreshness,
} from "./codebase-memory-adapter.js";
import { canInject } from "./cbm-index.js";
import type { RetrievalStore } from "./context-compressor.js";
import type { ToolUsage } from "./run-report.js";

export const GRAPH_BLOCK_TAG = "graph-map";

const NAV_HEADER =
  "This is a code-navigation map from a local graph index. It can be stale for " +
  "dynamic dispatch or generated code — read the actual source before changing " +
  "it, and let tests remain the completion gate.";

export function stageQueries(
  stage: string,
  ctx: { changedFiles?: string[]; taskHint?: string }
): CbmRequest[] {
  switch (stage) {
    case "plan":
      return [{ operation: "get_architecture", params: {} }];
    case "implementer":
      return [
        { operation: "search_graph", params: { query: ctx.taskHint ?? "" } },
      ];
    case "reviewer":
    case "verifier":
      return [
        {
          operation: "detect_changes",
          params: { files: ctx.changedFiles ?? [] },
        },
        { operation: "trace_path", params: { files: ctx.changedFiles ?? [] } },
      ];
    default:
      return [];
  }
}

export type CbmInjection = { block: string; toolUsage: ToolUsage };

function usage(
  stage: string,
  freshness: IndexFreshness,
  over: Partial<ToolUsage>
): ToolUsage {
  return {
    name: "codebase-memory",
    kind: "mcp",
    stage,
    indexFreshness: freshness,
    ...over,
  };
}

export function buildCbmInjection(opts: {
  stage: string;
  requests: CbmRequest[];
  runner: CbmRunner;
  freshness: IndexFreshness;
  maxChars: number;
  store?: RetrievalStore | null;
}): CbmInjection {
  const gate = canInject(opts.freshness);
  const query = opts.requests.map((r) => r.operation).join(",");
  if (!gate.inject || opts.requests.length === 0) {
    return {
      block: "",
      toolUsage: usage(opts.stage, opts.freshness, {
        query,
        fallbackReason: gate.fallbackReason ?? "no query for stage",
      }),
    };
  }
  const parts: string[] = [];
  for (const req of opts.requests) {
    const res = opts.runner.call(req);
    if (!res.ok) {
      return {
        block: "",
        toolUsage: usage(opts.stage, opts.freshness, {
          query,
          fallbackReason: `query failed: ${res.error ?? "unknown"}`,
        }),
      };
    }
    parts.push(
      typeof res.result === "string" ? res.result : JSON.stringify(res.result)
    );
  }
  const full = parts.join("\n");
  const handle = opts.store
    ? opts.store(`graph-map-${opts.stage}`, full)
    : undefined;
  const bounded =
    full.length > opts.maxChars ? `${full.slice(0, opts.maxChars)}…` : full;
  const block = `<${GRAPH_BLOCK_TAG}>\n${NAV_HEADER}\n\n${bounded}\n</${GRAPH_BLOCK_TAG}>`;
  return {
    block,
    toolUsage: usage(opts.stage, opts.freshness, {
      query,
      resultSize: full.length,
      retrievalHandle: handle,
    }),
  };
}
```

Export `stageQueries`, `buildCbmInjection`, `CbmInjection`, `GRAPH_BLOCK_TAG` from `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-inject`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/cbm-inject.ts packages/core/src/index.ts packages/core/src/__tests__/cbm-inject.test.ts
git commit -m "feat(cbm): per-stage query map + bounded navigation-only injection (P26 slice2)"
```

---

### Task 4: P22 lifecycle classification of the graph block

**Files:**

- Modify: `packages/core/src/context-report.ts` (`BLOCK_CATEGORY`)
- Test: `packages/core/src/__tests__/cbm-lifecycle.test.ts`

**Interfaces:**

- Consumes: `GRAPH_BLOCK_TAG` (Task 3, value `"graph-map"`); `analyzeContext` / `classifyLifecycle` (existing).
- Produces: a `"graph-map": "evidence"` entry in `BLOCK_CATEGORY` so an injected `<graph-map>` block classifies `evidence` → `retrievable` lifecycle.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/cbm-lifecycle.test.ts
import { describe, it, expect } from "vitest";
import { analyzeContext } from "../context-report.js";

describe("graph-map lifecycle", () => {
  it("classifies an injected <graph-map> block as retrievable evidence", () => {
    const prompt = "before\n<graph-map>\narch summary\n</graph-map>\nafter";
    const breakdown = analyzeContext(prompt);
    const evidence = breakdown.segments.find((s) => s.category === "evidence");
    expect(evidence).toBeDefined();
    expect(evidence?.lifecycle).toBe("retrievable");
  });
});
```

(If `analyzeContext`'s return shape differs — e.g. `byCategory` totals rather than `segments` — assert on whatever it exposes that carries the `evidence`/`retrievable` classification; read the current `ContextBreakdown` type first and match it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-lifecycle`
Expected: FAIL — `<graph-map>` not categorized as evidence.

- [ ] **Step 3: Implement**

Add the tag to `BLOCK_CATEGORY` in `context-report.ts`:

```ts
const BLOCK_CATEGORY: Record<string, ContextCategory> = {
  commits: "commits",
  learnings: "learnings",
  inputs: "inputs",
  issue: "evidence",
  "issues-summary": "evidence",
  "issues-full-file": "evidence",
  // Injected code-graph navigation results (P26 slice2): retrievable evidence —
  // the full result is stored via runRetrievalStore, so later prompts retire it.
  "graph-map": "evidence",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-lifecycle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/context-report.ts packages/core/src/__tests__/cbm-lifecycle.test.ts
git commit -m "feat(cbm): classify injected graph-map block as retrievable (P26 slice2)"
```

---

### Task 5: Loop wiring — preflight index, refresh-before-review, per-stage injection

**Files:**

- Modify: `packages/core/src/loop.ts`
- Test: `packages/core/src/__tests__/loop.test.ts` (extend)

**Interfaces:**

- Consumes: `runIndexRepository`/`decideIndexAction` (Tasks 1–2); `stageQueries`/`buildCbmInjection` (Task 3); `readTools`/`readToolConfig`/`toolEnabledForStage`/`authorizeToolOperation` (`tools.ts`); `runRetrievalStore` (already created per run in `loop.ts:~550`); the `codebaseMemoryToolDefinition().name` = `"codebase-memory"`.
- Produces: per-stage `injectedContext` from the graph when the `codebase-memory` tool is enabled for that stage; `ToolUsage` pushed into the stage's `toolsUsed[]`; manifest `codebaseMemory` build/refresh timings. **Inert (byte-for-byte) when the tool is not enabled for the stage.**

**Design notes for the implementer (read before coding):**

- Gate exactly like P25 Task 7's `bindWorktreeIdentity`: the tool is "active for stage S" iff `.otto/tools/codebase-memory.json` is registered AND `toolEnabledForStage(tool, config, S).enabled`. When not active, do NOT compute identity, index, or inject — the existing `executeStage` call is unchanged.
- Build a runner once per run: `createStdioCbmRunner(tool.command ?? "codebase-memory", workspaceDir, tool.timeoutMs ?? 120000)`. Guard with `runner.available()`; unavailable ⇒ skip all CBM work + record a manifest `codebaseMemory` note (no throw).
- Preflight index: compute `current = { workspace: workspaceDir, sourceRevision: headSha(workspaceDir), worktreeDirty: <git status --porcelain nonempty> }`. Read the persisted identity from the scratch dir (a small JSON you write next to the index); `decideIndexAction`; on `reindex`, first `authorizeToolOperation(policy, tool, config, "plan", "index_repository", { writePaths: [scratchDir] })` — if denied, fall back; else `runIndexRepository({ runner, scratchDir: join(workspaceDir, ".otto", "cbm-scratch"), declaredRoots: [".otto/cbm-scratch"], snapshot: listFilesRecursive, identity: {...current, toolVersion, indexedAt: nowIso()} })`. Persist `result.identity` on success; set `fanout`-style manifest `codebaseMemory = { indexIdentity, buildMs }`.
- Per stage in the chain, when active: `const inj = buildCbmInjection({ stage: stageName, requests: stageQueries(stageName, { changedFiles, taskHint: inputs }), runner, freshness: lastFreshness, maxChars: 4000, store: retrievalStore })`. Pass `inj.block` as `executeStage(..., { injectedContext: mergeInjected(existingInjected, inj.block) })` and push `inj.toolUsage` into that stage's `toolsUsed`. `mergeInjected` concatenates with the existing sharpening/cross-task blocks (don't clobber them).
- Refresh before reviewer: after the implementer stage(s), recompute `current` (revision/dirty changed by the diff) and repeat the index decision; update `lastFreshness` + manifest `refreshMs`.

- [ ] **Step 1: Write the failing test (inert-by-default guard + active injection)**

```ts
// in loop.test.ts — two cases
it("injects nothing when codebase-memory is not enabled (byte-for-byte)", async () => {
  // Run the loop with no .otto/tools/codebase-memory.json; capture the prompt
  // passed to executeStage via the existing stage-exec seam the loop tests use.
  // Assert no <graph-map> appears in any stage prompt.
  // (Mirror the existing loop.test harness that captures injectedContext.)
});

it("injects a <graph-map> block into an enabled stage", async () => {
  // Register an enabled codebase-memory tool (stages:["plan"]) + a stub runner
  // seam; assert the plan stage prompt contains "<graph-map>" and a toolsUsed
  // entry with name "codebase-memory" is recorded.
});
```

Replace these with concrete assertions using `loop.test.ts`'s existing seams for injecting a fake tool registry / stage-exec capture (grep the file for how P25 Task 6/7 tests drove `runPanel`/`runFanout` and tool enablement — reuse that exact mechanism; the runner must be injectable so no real process spawns).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- loop.test`
Expected: FAIL — no `<graph-map>` injected / no tool wiring.

- [ ] **Step 3: Implement the loop wiring**

Add a `codebase-memory` block in `loop.ts` following the design notes above. Keep it entirely inside an `if (cbmActiveForRun)` guard so a bare run is unchanged. Reuse the per-run `retrievalStore` already constructed. Make the runner injectable (add an optional `RunLoopOptions.cbmRunner` seam defaulting to `createStdioCbmRunner`, mirroring how fan-out's `runSubAgent` is injectable) so the test drives a stub.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- loop.test`
Expected: PASS (both cases). Also run `pnpm --filter @phamvuhoang/otto-core test` to confirm no regression.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/loop.ts packages/core/src/__tests__/loop.test.ts
git commit -m "feat(cbm): wire confined indexing + per-stage graph injection into the loop (P26 slice2)"
```

---

### Task 6: Source-before-edit playbook instruction

**Files:**

- Modify: `packages/core/templates/prompt.md` (and `ghprompt.md`/`linearprompt.md` if they share the edit playbook)
- Test: `packages/core/src/__tests__/cbm-inject.test.ts` (extend — the block header already carries the instruction; add a playbook presence check if a template test harness exists)

**Interfaces:** none (template copy).

- [ ] **Step 1: Add the instruction**

In `templates/prompt.md`, near the implementation guidance, add one paragraph:

> If a `<graph-map>` navigation block is present, treat it as a map, not the source of truth: it can be stale for dynamic dispatch or generated code. Open and read the actual files before changing them; tests remain the completion gate.

- [ ] **Step 2: Verify the injected block already carries the same instruction**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-inject`
Expected: PASS — the existing "injects a bounded navigation-only block" test already asserts `/read the actual source/i` in the block (Task 3). No new code.

- [ ] **Step 3: Commit**

```bash
git add packages/core/templates/prompt.md
git commit -m "docs(cbm): playbook instruction to read source before editing over a graph-map (P26 slice2)"
```

---

### Task 7: Eval — live-injection A/B config + fallback/refresh fixtures

**Files:**

- Modify: `benchmarks/configs.json`
- Create: `benchmarks/fixtures/cbm-refresh/`, `benchmarks/fixtures/cbm-dynamic-fallback/` (each: source + `impact.json` where relevant + `README.md`)
- Test: existing `benchmarks-suite.test.mjs` structural checks

**Interfaces:** none (config + fixtures).

- [ ] **Step 1: Add the live-injection config**

Append to `benchmarks/configs.json` a config that enables injection:

```json
{
  "label": "cbm-inject",
  "args": ["--enable-tool", "codebase-memory"],
  "env": { "OTTO_CBM_E2E": "1" }
}
```

- [ ] **Step 2: Add the fixtures**

`benchmarks/fixtures/cbm-refresh/` — a task where an edit changes a symbol so the index must refresh before review to see the new caller graph; README documents the "refresh before review" expectation. `benchmarks/fixtures/cbm-dynamic-fallback/` — code using dynamic dispatch the graph can't resolve, where retrieval must defer to raw search; README documents the fallback. Register both in `benchmarks/suite.json` mirroring `cbm-cross-module`.

- [ ] **Step 3: Verify + commit**

Run: `pnpm test` (root `node --test`)
Expected: PASS — the suite structural test accepts the new fixtures.

```bash
git add benchmarks/configs.json benchmarks/fixtures/cbm-refresh benchmarks/fixtures/cbm-dynamic-fallback benchmarks/suite.json
git commit -m "test(cbm): live-injection A/B config + refresh/dynamic-fallback fixtures (P26 slice2)"
```

---

### Task 8: Gated real-binary e2e + docs

**Files:**

- Test: `packages/core/src/__tests__/cbm-e2e.test.ts` (extend — gated on `OTTO_CBM_E2E=1` + `available()`)
- Modify: `README.md`, `docs/EXTENSIONS.md`, `docs/HARNESS_ROADMAP_PHASE5.md`

**Interfaces:** Consumes `createStdioCbmRunner`, `runIndexRepository` (Task 1).

- [ ] **Step 1: Extend the gated e2e**

Add a case (guarded by the existing `OTTO_CBM_E2E === "1"` + `runner.available()` pattern) that runs a real confined `runIndexRepository` into a temp scratch and asserts `result.ok && result.writeInventory.escaped.length === 0` (real writes stayed confined). Skips in CI.

- [ ] **Step 2: Run to confirm it skips in CI**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-e2e`
Expected: PASS with the new case reported skipped.

- [ ] **Step 3: Docs**

In `docs/EXTENSIONS.md`, extend the "Codebase Memory (P26)" section: it is now a **production adapter** — off by default, enabled per-stage via config, with confined indexing, freshness/refresh, bounded navigation-only injection, and a fallback on any degradation. Note the operator enables injection only after the `otto-eval compare cbm-off cbm-on` numbers are acceptable. Update `README.md`'s pointer and the `docs/HARNESS_ROADMAP_PHASE5.md` status line to note the P26 production adapter landed.

- [ ] **Step 4: Full verify + commit**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all PASS (cbm-e2e cases skipped).

```bash
git add packages/core/src/__tests__/cbm-e2e.test.ts README.md docs/EXTENSIONS.md docs/HARNESS_ROADMAP_PHASE5.md
git commit -m "test(cbm): gated confined-index e2e + production-adapter docs (P26 slice2)"
```

---

## Self-Review Notes

- **Spec coverage:** confined indexing (T1), freshness/reuse+inject-gate (T2), per-stage query + bounded injection (T3), P22 retrievable classification (T4), loop wiring: preflight/refresh/per-stage inject + inert-by-default (T5), source-before-edit (T3 block header + T6 playbook), eval A/B + fallback/refresh fixtures (T7), gated e2e + docs (T8). All eight spec scope bullets + all eight success criteria map to a task.
- **Type consistency:** `IndexResult`/`IndexInputs`/`CbmIndexIdentity` (T1) consumed by T5; `decideIndexAction`/`canInject`/`IndexAction` (T2) consumed by T3 (`canInject`) + T5; `GRAPH_BLOCK_TAG` = `"graph-map"` defined T3, referenced by T4's `BLOCK_CATEGORY` key and T4's test; `buildCbmInjection`/`stageQueries`/`CbmInjection` (T3) consumed by T5; `ToolUsage`/`RetrievalStore` reused from existing modules (not redefined).
- **Gate honored:** enablement stays off-by-default (T5 guard); the `cbm-inject` benchmark config (T7) is the operator's A/B; nothing activates injection without the tool being registered + enabled for a stage.
- **Deferred (spec out-of-scope, intentionally not planned):** agent-driven MCP exposure, harness read-tracking check, default-on.
