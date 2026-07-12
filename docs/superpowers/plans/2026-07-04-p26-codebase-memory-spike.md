# P26a Codebase Memory Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an off-by-default, policy-governed Codebase Memory MCP adapter plus a governance/retrieval-benchmark spike — with **no default stage behavior change** — so a later slice can decide from Otto's own eval evidence whether to inject graph results into live stages.

**Architecture:** A new `codebase-memory-adapter.ts` modeled on `headroom-adapter.ts` runs an Otto-owned stdio MCP child through a minimal hand-rolled newline-delimited JSON-RPC client behind an injectable `CbmRunner` contract. A net-new per-operation allowlist on `ToolDefinition` separates the single write op (`index_repository`) from read ops. A freshness contract, a scratch write inventory, evidence fields on `ToolUsage`, and new eval signals make the spike measurable. All harness logic is unit-tested with a stub runner (CI); real transport + the retrieval benchmark run only under `OTTO_CBM_E2E=1` against an operator-provided pinned binary.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥20, vitest. `packages/core` only. No new npm dependencies.

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **No new npm dependencies.** MCP client is hand-rolled.
- **Report/eval-only.** No injection into live `plan`/`implementer`/`reviewer`/`verifier` prompts; no indexing of a live target; excluded ops (`delete_project`, `manage_adr`, `ingest_traces`, graph UI, shared artifacts) are never called.
- **Off by default.** Nothing runs unless the `codebase-intelligence` profile is applied and stages are opted in; even then, no live injection in this slice.
- **No network at runtime** (`networkDomains: []`), **writes only to `.codebase-memory` / scratch**, **no upstream `install`/`update`, no personal-config mutation.**
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit runs prettier + typecheck.
- **Never hand-edit release version state.** release-please owns it.

---

### Task 1: Per-operation authority (`operations` field + `authorizeToolOperation`)

**Files:**

- Modify: `packages/core/src/tools.ts` (add `ToolOperation` type; `operations` field on `ToolDefinition` at `:53-80`; `parseTool` normalization at `:129`; new `authorizeToolOperation`)
- Modify: `packages/core/src/index.ts` (export the new type + function alongside existing tools exports at `:295-322`)
- Test: `packages/core/src/__tests__/tool-operations.test.ts`

**Interfaces:**

- Consumes: existing `authorizeToolInvocation(policy, tool, invocation): ToolAuthorization`, `ToolInvocation`, `ToolAuthorization`, `SafetyEvent`, `PolicyViolation`, `ToolConfig`, `toolEnabledForStage` (all in `tools.ts`).
- Produces:
  - `export type ToolOperation = { name: string; write: boolean };`
  - `ToolDefinition.operations?: ToolOperation[]` (optional — absent ⇒ today's behavior).
  - `export function authorizeToolOperation(policy: SafetyPolicy, tool: ToolDefinition, config: ToolConfig, stage: string, operation: string, invocation: ToolInvocation): ToolAuthorization` — allowed only if: the tool is enabled for `stage`, `operation` is declared in `tool.operations`, and (if the op is a write) the invocation's write paths pass `authorizeToolInvocation`. Undeclared/excluded ops produce a `blocked` `policy-violation` `SafetyEvent`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/tool-operations.test.ts
import { describe, it, expect } from "vitest";
import { authorizeToolOperation, type ToolDefinition } from "../tools.js";
import { DEFAULT_POLICY } from "../safety-policy.js";

const CBM: ToolDefinition = {
  name: "codebase-memory",
  kind: "mcp",
  description: "",
  capabilities: [],
  stages: ["plan", "reviewer"],
  env: [],
  networkDomains: [],
  writeRoots: [".codebase-memory"],
  secretRefs: [],
  approvalActions: [],
  enabled: true,
  operations: [
    { name: "index_repository", write: true },
    { name: "get_architecture", write: false },
    { name: "search_graph", write: false },
  ],
};
const CONFIG = { overrides: {} };

describe("authorizeToolOperation", () => {
  it("allows a declared read op on an enabled stage", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      CBM,
      CONFIG,
      "plan",
      "search_graph",
      {}
    );
    expect(a.allowed).toBe(true);
    expect(a.violations).toEqual([]);
  });

  it("allows the single write op with in-scope write paths", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      CBM,
      CONFIG,
      "plan",
      "index_repository",
      {
        writePaths: [".codebase-memory/graph.db.zst"],
      }
    );
    expect(a.allowed).toBe(true);
  });

  it("blocks an undeclared/excluded op and emits a policy-violation event", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      CBM,
      CONFIG,
      "plan",
      "delete_project",
      {}
    );
    expect(a.allowed).toBe(false);
    expect(a.events.some((e) => e.kind === "policy-violation")).toBe(true);
  });

  it("blocks any op on a stage the tool is not enabled for", () => {
    const a = authorizeToolOperation(
      DEFAULT_POLICY,
      CBM,
      CONFIG,
      "implementer",
      "search_graph",
      {}
    );
    expect(a.allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- tool-operations`
Expected: FAIL — `authorizeToolOperation is not exported` / not a function.

- [ ] **Step 3: Implement `ToolOperation`, the `operations` field, and `authorizeToolOperation`**

In `tools.ts`, add the type and field:

```ts
export type ToolOperation = { name: string; write: boolean };

// in ToolDefinition:
//   operations?: ToolOperation[];   // per-op allowlist; absent = no op gating
```

In `parseTool`, normalize `operations` defensively (mirror the existing array-normalization style):

```ts
const operations = Array.isArray((raw as any).operations)
  ? (raw as any).operations
      .filter((o: any) => o && typeof o.name === "string")
      .map((o: any) => ({ name: o.name, write: o.write === true }))
  : undefined;
// include `operations` in the returned object
```

Add the predicate (compose with existing `toolEnabledForStage` + `authorizeToolInvocation`):

```ts
export function authorizeToolOperation(
  policy: SafetyPolicy,
  tool: ToolDefinition,
  config: ToolConfig,
  stage: string,
  operation: string,
  invocation: ToolInvocation
): ToolAuthorization {
  const stageGate = toolEnabledForStage(tool, config, stage);
  if (!stageGate.enabled) {
    return blocked(
      "approval-required",
      operation,
      `tool not enabled for stage ${stage}: ${stageGate.reason}`
    );
  }
  const op = tool.operations?.find((o) => o.name === operation);
  if (!op) {
    return blocked(
      "approval-required",
      operation,
      `operation not in allowlist: ${operation}`
    );
  }
  // Read ops need no write authority; write ops go through the full intersection.
  if (!op.write) return { allowed: true, violations: [], events: [] };
  return authorizeToolInvocation(policy, tool, invocation);
}
```

Add a small `blocked(kind, subject, message)` helper that returns `{ allowed:false, violations:[{kind,subject,message}], events:[{kind:"policy-violation", ...}] }` matching the shapes already in `tools.ts` (reuse `violationToSafetyEvent` if present, else construct inline to match `SafetyEvent`). Export `authorizeToolOperation` + `ToolOperation` from `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- tool-operations`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/tools.ts packages/core/src/index.ts packages/core/src/__tests__/tool-operations.test.ts
git commit -m "feat(tools): per-operation authority for MCP adapters (P26)"
```

---

### Task 2: Codebase Memory adapter — stdio JSON-RPC client + `CbmRunner` + tool factory

**Files:**

- Create: `packages/core/src/codebase-memory-adapter.ts`
- Modify: `packages/core/src/index.ts` (export the factory + `CbmRunner` + result types)
- Test: `packages/core/src/__tests__/codebase-memory-adapter.test.ts`

**Interfaces:**

- Consumes: `ToolDefinition`, `ToolOperation` (Task 1); `ToolResult`, `ToolUsage` shapes.
- Produces:
  - `export type CbmRequest = { operation: string; params: Record<string, unknown> };`
  - `export type CbmResponse = { ok: boolean; result?: unknown; error?: string };`
  - `export type CbmRunner = { available(): boolean; call(req: CbmRequest): CbmResponse };` — the injectable seam (real impl spawns the child; tests inject a stub).
  - `export function codebaseMemoryToolDefinition(command?: string): ToolDefinition` — mirrors `headroomToolDefinition()`; `kind:"mcp"`, `networkDomains: []`, `writeRoots: [".codebase-memory"]`, `healthCheck`, `timeoutMs`, and the operations allowlist (write `index_repository`; reads `index_status`, `get_graph_schema`, `get_architecture`, `search_graph`, `trace_path`, `detect_changes`, `search_code`, `get_code_snippet`).
  - `export function createStdioCbmRunner(command: string, cwd: string, timeoutMs: number): CbmRunner` — real transport (only exercised under the gated e2e).

- [ ] **Step 1: Write the failing test (stub runner, no real process)**

```ts
// packages/core/src/__tests__/codebase-memory-adapter.test.ts
import { describe, it, expect } from "vitest";
import {
  codebaseMemoryToolDefinition,
  type CbmRunner,
} from "../codebase-memory-adapter.js";

describe("codebaseMemoryToolDefinition", () => {
  it("declares no network, cache-only writes, and the op allowlist", () => {
    const t = codebaseMemoryToolDefinition("cbm");
    expect(t.kind).toBe("mcp");
    expect(t.networkDomains).toEqual([]);
    expect(t.writeRoots).toEqual([".codebase-memory"]);
    const names = (t.operations ?? []).map((o) => o.name);
    expect(names).toContain("index_repository");
    expect(names).toContain("search_graph");
    expect(names).not.toContain("delete_project");
    expect(
      t.operations?.find((o) => o.name === "index_repository")?.write
    ).toBe(true);
    expect(t.operations?.find((o) => o.name === "search_graph")?.write).toBe(
      false
    );
  });
});

describe("CbmRunner stub contract", () => {
  it("returns a structured response for an allowed op", () => {
    const stub: CbmRunner = {
      available: () => true,
      call: (req) => ({
        ok: true,
        result: { architecture: `for:${req.operation}` },
      }),
    };
    expect(stub.call({ operation: "get_architecture", params: {} }).ok).toBe(
      true
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- codebase-memory-adapter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the factory + runner contract + minimal stdio client**

```ts
// packages/core/src/codebase-memory-adapter.ts
import { spawnSync } from "node:child_process";
import type { ToolDefinition, ToolOperation } from "./tools.js";

export type CbmRequest = { operation: string; params: Record<string, unknown> };
export type CbmResponse = { ok: boolean; result?: unknown; error?: string };
export type CbmRunner = {
  available(): boolean;
  call(req: CbmRequest): CbmResponse;
};

const READ_OPS = [
  "index_status",
  "get_graph_schema",
  "get_architecture",
  "search_graph",
  "trace_path",
  "detect_changes",
  "search_code",
  "get_code_snippet",
];
const OPERATIONS: ToolOperation[] = [
  { name: "index_repository", write: true },
  ...READ_OPS.map((name) => ({ name, write: false })),
];

export function codebaseMemoryToolDefinition(
  command = "codebase-memory"
): ToolDefinition {
  return {
    name: "codebase-memory",
    kind: "mcp",
    description:
      "Local code-knowledge graph via an Otto-owned MCP stdio child.",
    capabilities: [
      "architecture",
      "call-path",
      "change-impact",
      "symbol-search",
    ],
    stages: [], // opt-in via config; no default injection
    command,
    env: [],
    networkDomains: [], // no runtime network
    writeRoots: [".codebase-memory"], // cache-only
    secretRefs: [],
    timeoutMs: 120_000,
    healthCheck: `${command} --version`,
    approvalActions: [],
    enabled: false,
    operations: OPERATIONS,
  };
}

// Minimal newline-delimited JSON-RPC over stdio. Real transport — only exercised
// under the gated e2e; unit tests inject a CbmRunner stub instead.
export function createStdioCbmRunner(
  command: string,
  cwd: string,
  timeoutMs: number
): CbmRunner {
  const [bin, ...args] = command.split(" ");
  const available = () => {
    const probe = spawnSync(bin, ["--version"], { cwd, timeout: 5000 });
    return probe.status === 0;
  };
  // One-shot request/response: initialize handshake + tools/call, newline-framed.
  const call = (req: CbmRequest): CbmResponse => {
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const callMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: req.operation, arguments: req.params },
    });
    const proc = spawnSync(bin, args, {
      cwd,
      timeout: timeoutMs,
      input: `${init}\n${callMsg}\n`,
    });
    if (proc.status !== 0)
      return { ok: false, error: proc.stderr?.toString() || "child failed" };
    const lines = proc.stdout.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 2 && msg.result) return { ok: true, result: msg.result };
        if (msg.id === 2 && msg.error)
          return { ok: false, error: String(msg.error.message ?? msg.error) };
      } catch {
        /* ignore non-JSON banner lines */
      }
    }
    return { ok: false, error: "no response for tools/call" };
  };
  return { available, call };
}
```

Export the three types + `codebaseMemoryToolDefinition` + `createStdioCbmRunner` from `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- codebase-memory-adapter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/codebase-memory-adapter.ts packages/core/src/index.ts packages/core/src/__tests__/codebase-memory-adapter.test.ts
git commit -m "feat(cbm): stdio MCP adapter + tool factory behind injectable runner (P26)"
```

---

### Task 3: Freshness contract + scratch write inventory

**Files:**

- Modify: `packages/core/src/codebase-memory-adapter.ts` (add identity/freshness + inventory helpers)
- Test: `packages/core/src/__tests__/cbm-freshness.test.ts`

**Interfaces:**

- Produces:
  - `export type CbmIndexIdentity = { workspace: string; sourceRevision: string; worktreeDirty: boolean; toolVersion: string; indexStatus: string; indexedAt: string };`
  - `export type IndexFreshness = "fresh" | "stale" | "absent" | "wrong-project";`
  - `export function classifyIndexFreshness(current: { workspace: string; sourceRevision: string; worktreeDirty: boolean } | null, index: CbmIndexIdentity | null): IndexFreshness` — `absent` if no index; `wrong-project` if workspace mismatch; `stale` if revision differs or the worktree is dirty; else `fresh`.
  - `export type WriteInventory = { files: string[]; escaped: string[] };`
  - `export function diffWriteInventory(before: string[], after: string[], declaredRoots: string[]): WriteInventory` — new files = `after \ before`; `escaped` = new files not under any `declaredRoots` prefix.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/cbm-freshness.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyIndexFreshness,
  diffWriteInventory,
  type CbmIndexIdentity,
} from "../codebase-memory-adapter.js";

const idx: CbmIndexIdentity = {
  workspace: "/repo",
  sourceRevision: "abc123",
  worktreeDirty: false,
  toolVersion: "1.0.0",
  indexStatus: "ready",
  indexedAt: "2026-07-04T00:00:00Z",
};

describe("classifyIndexFreshness", () => {
  it("absent when no index", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/repo", sourceRevision: "abc123", worktreeDirty: false },
        null
      )
    ).toBe("absent");
  });
  it("wrong-project on workspace mismatch", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/other", sourceRevision: "abc123", worktreeDirty: false },
        idx
      )
    ).toBe("wrong-project");
  });
  it("stale on revision drift", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/repo", sourceRevision: "def456", worktreeDirty: false },
        idx
      )
    ).toBe("stale");
  });
  it("stale when worktree dirty", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/repo", sourceRevision: "abc123", worktreeDirty: true },
        idx
      )
    ).toBe("stale");
  });
  it("fresh when identity matches and clean", () => {
    expect(
      classifyIndexFreshness(
        { workspace: "/repo", sourceRevision: "abc123", worktreeDirty: false },
        idx
      )
    ).toBe("fresh");
  });
});

describe("diffWriteInventory", () => {
  it("flags a write outside the declared cache", () => {
    const inv = diffWriteInventory(
      [".codebase-memory/a"],
      [".codebase-memory/a", ".codebase-memory/graph.db.zst", ".gitattributes"],
      [".codebase-memory"]
    );
    expect(inv.files).toEqual([
      ".codebase-memory/graph.db.zst",
      ".gitattributes",
    ]);
    expect(inv.escaped).toEqual([".gitattributes"]);
  });
  it("passes when all writes stay inside the cache", () => {
    const inv = diffWriteInventory(
      [],
      [".codebase-memory/graph.db.zst"],
      [".codebase-memory"]
    );
    expect(inv.escaped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-freshness`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the helpers (pure)**

```ts
// in codebase-memory-adapter.ts
export type CbmIndexIdentity = {
  workspace: string;
  sourceRevision: string;
  worktreeDirty: boolean;
  toolVersion: string;
  indexStatus: string;
  indexedAt: string;
};
export type IndexFreshness = "fresh" | "stale" | "absent" | "wrong-project";

export function classifyIndexFreshness(
  current: {
    workspace: string;
    sourceRevision: string;
    worktreeDirty: boolean;
  } | null,
  index: CbmIndexIdentity | null
): IndexFreshness {
  if (!index || !current) return "absent";
  if (index.workspace !== current.workspace) return "wrong-project";
  if (index.sourceRevision !== current.sourceRevision || current.worktreeDirty)
    return "stale";
  return "fresh";
}

export type WriteInventory = { files: string[]; escaped: string[] };
export function diffWriteInventory(
  before: string[],
  after: string[],
  declaredRoots: string[]
): WriteInventory {
  const beforeSet = new Set(before);
  const files = after.filter((f) => !beforeSet.has(f));
  const under = (f: string) =>
    declaredRoots.some(
      (r) => f === r || f.startsWith(r.endsWith("/") ? r : `${r}/`)
    );
  return { files, escaped: files.filter((f) => !under(f)) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-freshness`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/codebase-memory-adapter.ts packages/core/src/__tests__/cbm-freshness.test.ts
git commit -m "feat(cbm): index freshness contract + scratch write inventory (P26)"
```

---

### Task 4: Evidence fields on `ToolUsage` + run-level index record + context-report aggregator

**Files:**

- Modify: `packages/core/src/run-report.ts` (`ToolUsage` at `:88-101`; add optional `RunManifest` field mirroring `inputSharpness`)
- Modify: `packages/core/src/context-compressor.ts` (add `summarizeGraphRetrieval`, mirror `summarizeToolCompression` at `:445`)
- Test: `packages/core/src/__tests__/cbm-evidence.test.ts`

**Interfaces:**

- Produces:
  - `ToolUsage` gains: `toolVersion?: string; indexIdentity?: CbmIndexIdentity; indexFreshness?: IndexFreshness; tokensAvoided?: number; resultSize?: number; latencyMs?: number; query?: string; fallbackReason?: string;` (import the two types from the adapter).
  - `RunManifest.codebaseMemory?: { indexIdentity?: CbmIndexIdentity; buildMs?: number; refreshMs?: number; writeInventory?: WriteInventory }` (optional; absent for non-CBM runs).
  - `export function summarizeGraphRetrieval(usages: ToolUsage[]): { queries: number; tokensAvoided: number; fallbacks: number } | undefined` — undefined when no `codebase-memory` usage present.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/cbm-evidence.test.ts
import { describe, it, expect } from "vitest";
import { summarizeGraphRetrieval } from "../context-compressor.js";
import type { ToolUsage } from "../run-report.js";

describe("summarizeGraphRetrieval", () => {
  it("undefined when no codebase-memory usage", () => {
    expect(
      summarizeGraphRetrieval([{ name: "headroom", kind: "command" }])
    ).toBeUndefined();
  });
  it("aggregates queries, tokens avoided, and fallbacks", () => {
    const usages: ToolUsage[] = [
      {
        name: "codebase-memory",
        kind: "mcp",
        tokensAvoided: 1200,
        query: "arch",
      },
      {
        name: "codebase-memory",
        kind: "mcp",
        tokensAvoided: 300,
        fallbackReason: "stale index",
      },
    ];
    expect(summarizeGraphRetrieval(usages)).toEqual({
      queries: 2,
      tokensAvoided: 1500,
      fallbacks: 1,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-evidence`
Expected: FAIL — `summarizeGraphRetrieval` not exported / `ToolUsage` fields missing (typecheck error).

- [ ] **Step 3: Extend `ToolUsage` + `RunManifest`, implement the aggregator**

In `run-report.ts`, import `CbmIndexIdentity`, `IndexFreshness`, `WriteInventory` from `./codebase-memory-adapter.js` and add the optional fields listed in Interfaces to `ToolUsage` and `RunManifest`. In `context-compressor.ts`:

```ts
import type { ToolUsage } from "./run-report.js";

export function summarizeGraphRetrieval(usages: ToolUsage[]) {
  const graph = usages.filter((u) => u.name === "codebase-memory");
  if (graph.length === 0) return undefined;
  return {
    queries: graph.length,
    tokensAvoided: graph.reduce((s, u) => s + (u.tokensAvoided ?? 0), 0),
    fallbacks: graph.filter((u) => u.fallbackReason).length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-evidence`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/run-report.ts packages/core/src/context-compressor.ts packages/core/src/__tests__/cbm-evidence.test.ts
git commit -m "feat(cbm): retrieval evidence fields + context-report aggregator (P26)"
```

---

### Task 5: Eval signals + `cbm-off`/`cbm-on` configs + impact-recall scoring

**Files:**

- Modify: `packages/core/src/eval.ts` (`EvalSignals` at `:17-52`; `COMPARE_COLUMNS` at `:113`; `scoreTrajectory` at `:62`)
- Modify: `benchmarks/configs.json` (add `cbm-off` / `cbm-on`)
- Create: `benchmarks/fixtures/cbm-cross-module/` (+ `README.md`, source with a buried dependency, and a known-impact fact list `impact.json`)
- Test: `packages/core/src/__tests__/cbm-eval-signals.test.ts`

**Interfaces:**

- Consumes: `assessFactSurvival(facts, text)` from `compression-survival.ts:44`.
- Produces:
  - `EvalSignals` gains `toolCallCount: number; tokensAvoided: number; impactRecall: number; indexingOverheadMs: number;`.
  - A `COMPARE_COLUMNS` entry per new signal (direction: `tokensAvoided`↑ better, `toolCallCount`↓ better, `impactRecall`↑ better, `indexingOverheadMs`↓ better).
  - `export function scoreImpactRecall(knownImpactedFiles: string[], answerText: string): number` — thin wrapper over `assessFactSurvival` returning `survivalRate`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/cbm-eval-signals.test.ts
import { describe, it, expect } from "vitest";
import { scoreImpactRecall } from "../eval.js";

describe("scoreImpactRecall", () => {
  it("full recall when every impacted file appears in the answer", () => {
    const r = scoreImpactRecall(
      ["src/a.ts", "src/b.ts"],
      "changing src/a.ts also breaks src/b.ts"
    );
    expect(r).toBe(1);
  });
  it("partial recall when some impacted files are missing", () => {
    const r = scoreImpactRecall(
      ["src/a.ts", "src/b.ts"],
      "only src/a.ts matters"
    );
    expect(r).toBeCloseTo(0.5, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-eval-signals`
Expected: FAIL — `scoreImpactRecall` not exported.

- [ ] **Step 3: Implement scoring + extend signals/columns**

```ts
// in eval.ts
import { assessFactSurvival } from "./compression-survival.js";

export function scoreImpactRecall(
  knownImpactedFiles: string[],
  answerText: string
): number {
  if (knownImpactedFiles.length === 0) return 1;
  return assessFactSurvival(knownImpactedFiles, answerText).survivalRate;
}
```

Add the four fields to `EvalSignals`, default them in `scoreTrajectory` (read from manifest `codebaseMemory` + `toolsUsed` when present, else `0`), and add matching `COMPARE_COLUMNS` entries with correct direction flags.

- [ ] **Step 4: Add the A/B configs + fixture**

`benchmarks/configs.json` — append:

```json
{ "label": "cbm-off", "args": [], "env": {} },
{ "label": "cbm-on", "args": ["--enable-tool", "codebase-memory"], "env": { "OTTO_CBM_E2E": "1" } }
```

Create `benchmarks/fixtures/cbm-cross-module/` with a small multi-file module where a change in `src/a.ts` impacts `src/b.ts` through a non-obvious import, plus `impact.json` = `["src/a.ts","src/b.ts"]` and a `README.md` describing the buried dependency. (This fixture's real A/B run is gated; the pure scorer test above is CI.)

- [ ] **Step 5: Run tests + commit**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-eval-signals`
Expected: PASS.

```bash
pnpm -r typecheck && pnpm test
git add packages/core/src/eval.ts benchmarks/configs.json benchmarks/fixtures/cbm-cross-module packages/core/src/__tests__/cbm-eval-signals.test.ts
git commit -m "feat(cbm): eval signals, A/B configs, impact-recall scoring (P26)"
```

---

### Task 6: `codebase-intelligence` extension profile

**Files:**

- Modify: `packages/core/src/extension-profiles.ts` (add profile to `PROFILES` at `:48`, using `codebaseMemoryToolDefinition()`)
- Test: `packages/core/src/__tests__/codebase-intelligence-profile.test.ts`

**Interfaces:**

- Consumes: `codebaseMemoryToolDefinition()` (Task 2); `planProfile(profile)` (`extensions-cli.ts:61`), `ExtensionProfile` shape.
- Produces: a `codebase-intelligence` entry in `PROFILES` whose `tools` = `[codebaseMemoryToolDefinition()]`, `config.tools["codebase-memory"] = { enabled: true, stages: [] }` (opt-in, no live injection), `policy.allowedWriteRoots = [".codebase-memory"]`, `requires: ["codebase-memory"]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/codebase-intelligence-profile.test.ts
import { describe, it, expect } from "vitest";
import { PROFILES } from "../extension-profiles.js";

describe("codebase-intelligence profile", () => {
  it("ships the cbm tool with no network and cache-only writes", () => {
    const p = PROFILES.find((x) => x.name === "codebase-intelligence");
    expect(p).toBeDefined();
    const tool = p!.tools.find((t) => t.name === "codebase-memory");
    expect(tool?.kind).toBe("mcp");
    expect(tool?.networkDomains).toEqual([]);
    expect(p!.policy?.allowedWriteRoots).toContain(".codebase-memory");
    expect(p!.requires).toContain("codebase-memory");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- codebase-intelligence-profile`
Expected: FAIL — profile not found.

- [ ] **Step 3: Add the profile**

```ts
// in extension-profiles.ts, import codebaseMemoryToolDefinition, add to PROFILES:
{
  name: "codebase-intelligence",
  description: "Local code-knowledge graph (Codebase Memory) via an Otto-owned MCP stdio child. Off by default; no live prompt injection in the spike.",
  sources: [],
  tools: [codebaseMemoryToolDefinition()],
  config: { tools: { "codebase-memory": { enabled: true, stages: [] } } },
  policy: { allowedWriteRoots: [".codebase-memory"] },
  requires: ["codebase-memory"],
  followUp: "Next: otto-tools health && otto-tools why plan",
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- codebase-intelligence-profile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/extension-profiles.ts packages/core/src/__tests__/codebase-intelligence-profile.test.ts
git commit -m "feat(cbm): codebase-intelligence extension profile (P26)"
```

---

### Task 7: Gated real-binary e2e + docs + roadmap status

**Files:**

- Test: `packages/core/src/__tests__/cbm-e2e.test.ts` (gated on `OTTO_CBM_E2E=1` + `createStdioCbmRunner().available()`)
- Modify: `README.md`, `docs/EXTENSIONS.md`, `docs/HARNESS_ROADMAP_PHASE5.md` (status line ~5)

**Interfaces:**

- Consumes: `createStdioCbmRunner`, `codebaseMemoryToolDefinition`, `diffWriteInventory` (Tasks 2–3).

- [ ] **Step 1: Write the gated e2e (skips without the binary)**

```ts
// packages/core/src/__tests__/cbm-e2e.test.ts
import { describe, it, expect } from "vitest";
import { createStdioCbmRunner } from "../codebase-memory-adapter.js";

const optedIn = process.env.OTTO_CBM_E2E === "1";
const runner = optedIn
  ? createStdioCbmRunner("codebase-memory", process.cwd(), 120_000)
  : null;
const maybe = optedIn && runner?.available() ? it : it.skip;

describe("codebase-memory real binary (gated)", () => {
  maybe("answers an architecture query over stdio", () => {
    const res = runner!.call({ operation: "get_architecture", params: {} });
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm it skips in CI (no binary)**

Run: `pnpm --filter @phamvuhoang/otto-core test -- cbm-e2e`
Expected: PASS with the test reported as skipped.

- [ ] **Step 3: Document the spike**

Add a "Codebase Memory (P26, spike)" subsection to `docs/EXTENSIONS.md` describing: `otto-extensions init codebase-intelligence`, the operator-provided pinned binary requirement, the write-inventory/freshness governance, that it is report/eval-only with no live injection, and the `OTTO_CBM_E2E=1` + `otto-eval compare cbm-off cbm-on` workflow. Add a one-line pointer in `README.md`'s extensions/flags section. Update the `docs/HARNESS_ROADMAP_PHASE5.md` status line to note the P26 spike has landed.

- [ ] **Step 4: Full verify**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all PASS (cbm-e2e skipped).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/__tests__/cbm-e2e.test.ts README.md docs/EXTENSIONS.md docs/HARNESS_ROADMAP_PHASE5.md
git commit -m "test(cbm): gated real-binary e2e + docs for the P26 spike"
```

---

## Self-Review Notes

- **Spec coverage:** operations allowlist (T1), adapter+client+factory (T2), freshness+write-inventory (T3), evidence fields+aggregator (T4), eval signals+configs+fixtures+recall (T5), profile (T6), gated e2e+docs (T7). All eight spec scope bullets map to a task.
- **Deferred to a later slice (spec out-of-scope, intentionally not planned):** live-prompt injection, live-target indexing, P22 retirement of graph payloads.
- **Type consistency:** `CbmIndexIdentity` / `IndexFreshness` / `WriteInventory` defined in T2–T3 (adapter) and imported by T4 (run-report) and T7. `ToolOperation` defined in T1, consumed in T2. `ToolUsage` extended in T4, consumed by `summarizeGraphRetrieval` and `scoreTrajectory`.
