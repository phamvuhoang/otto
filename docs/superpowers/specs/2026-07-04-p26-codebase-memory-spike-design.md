# Spec — P26a: Codebase Memory governance & retrieval-benchmark spike

Source roadmap: `docs/HARNESS_ROADMAP_PHASE5.md` §P26 (issue
[#198](https://github.com/phamvuhoang/otto/issues/198)), "First P26
Implementation Slice" (steps 1–6). Epic
[#183](https://github.com/phamvuhoang/otto/issues/183).

**Report/eval-only. No default behavior change.**

## Problem

Otto agents spend many searches and reads reconstructing codebase structure and
change impact. The roadmap's bet (§P26) is that routing structural questions
through a local code-knowledge graph — [Codebase Memory / codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
— cuts exploration tokens and tool calls while keeping task success, because one
graph query answers cross-file architecture/caller/impact questions that
otherwise take many searches. The upstream evaluation reports ~10× fewer tokens
and 2.1× fewer tool calls at 83% answer quality vs 92% for file-by-file
exploration — an efficiency/quality **tradeoff**, not unconditional parity. That
means the bet must be _proven on Otto's own fixtures_ before any stage relies on
it, and the tool must be run under Otto's authority model, not its upstream
auto-installer (which can edit agent config, instructions, skills, and hooks).

Today Otto cannot do any of this:

- `kind: "mcp"` is a declared enum value in `tools.ts` with **zero runtime** — no
  stdio child, no JSON-RPC bridge, no MCP dependency. Headroom (`kind:"command"`)
  is the only real adapter.
- `authorizeToolInvocation` (`tools.ts:324`) gates command/network/write/action,
  but there is **no per-operation allowlist**, so `index_repository` (write)
  cannot be separated from read ops.
- There is no freshness contract, no write inventory, and no eval signal for
  tool calls / tokens avoided / impact recall.

## Goal

Prove retrieval value and MCP governance **without changing default stage
behavior**, so a later slice can decide — from Otto's own eval evidence, not the
upstream headline metrics — whether to inject graph results into live stages.

## Decisions (locked in brainstorming)

1. **Real binary, not a fake server.** The benchmark is the point; a fake proves
   nothing about token savings. The **harness logic** (authorization, operation
   allowlist, freshness classification, write-inventory diffing, evidence
   shaping, eval scoring) is pure and unit-tested in CI with an **injected stub
   runner**. The **real transport + retrieval benchmark** runs only against an
   operator-provided, checksum-pinned binary under `OTTO_CBM_E2E=1` (and the
   eval config). CI never requires the binary.
2. **Minimal hand-rolled stdio JSON-RPC client**, newline-delimited, behind an
   injectable `CbmRunner` contract. No `@modelcontextprotocol/sdk` dependency.
   Only the ~9 allowlisted operations are implemented.
3. **Governance before behavior.** Indexing runs against **scratch** with a full
   write inventory; a live target is never indexed in this slice.

## Scope

**In scope:**

- `packages/core/src/codebase-memory-adapter.ts`, modeled on
  `headroom-adapter.ts`:
  - Minimal stdio JSON-RPC client (spawn → `initialize` handshake → `tools/call`
    → shutdown) behind an injectable `CbmRunner` so tests inject canned results.
  - `codebaseMemoryToolDefinition()` factory (mirror `headroomToolDefinition()`):
    `kind:"mcp"`, stdio command, `networkDomains: []` (⇒ no runtime network for
    free per `tools.ts:338-343`), `writeRoots: [".codebase-memory", scratch]`,
    `healthCheck`, `timeoutMs`, and the new `operations` allowlist.
  - Availability probe: binary present + pinned version/checksum check.
- **Per-operation authority** — a net-new `operations: ToolOperation[]` field on
  `ToolDefinition` (each `{ name, write: boolean }`) and an
  `authorizeToolOperation(policy, tool, config, stage, op, invocation)` predicate
  that (a) rejects ops outside the allowlist, (b) treats only `index_repository`
  as a write op, (c) composes with the existing `authorizeToolInvocation`
  intersection. Backward compatible: absent `operations` ⇒ today's behavior.
  Allowlisted: write `index_repository`; read `index_status`,
  `get_graph_schema`, `get_architecture`, `search_graph`, `trace_path`,
  `detect_changes`, `search_code`, `get_code_snippet`. Excluded (assert-blocked):
  `delete_project`, `manage_adr`, `ingest_traces`, graph UI, shared artifacts.
- **Write inventory** — run `index_repository` pointed at scratch, snapshot the
  directory before/after, record every file written, and flag any write escaping
  the declared cache (`.codebase-memory/graph.db.zst`, `.gitattributes`). A
  governance artifact in the run bundle, not a live index.
- **Freshness contract** — `CbmIndexIdentity` { workspace, sourceRevision,
  worktreeDirty, toolVersion, indexStatus, indexedAt } and a
  `classifyIndexFreshness(): "fresh" | "stale" | "absent" | "wrong-project"`
  helper. Recorded, never used silently; mismatch ⇒ record + fall back.
- **Harness-owned query path** — a `runCbmQuery(...)` used only by the benchmark
  harness that runs architecture/call-chain/impact queries and returns bounded
  results + evidence, **without injecting into live stage prompts**.
- **Evidence** — extend `ToolUsage` (`run-report.ts:88-101`) with `toolVersion`,
  `indexIdentity`, `indexFreshness`, `tokensAvoided`, `resultSize`, `latencyMs`,
  `query` (sanitized), `fallbackReason`. Add a run-level index build/refresh
  record (mirror the `inputSharpness` optional-manifest-field pattern). Add a
  `summarizeGraphRetrieval` aggregator for the context report (mirror
  `summarizeToolCompression`).
- **Eval** — add `EvalSignals` fields `toolCallCount`, `tokensAvoided`,
  `impactRecall`, `indexingOverheadMs` + a `COMPARE_COLUMNS` entry; add
  `cbm-off` / `cbm-on` configs; add benchmark fixtures: cross-module call-chain
  with a buried dependency, multi-package architecture map, post-edit refresh,
  dynamic-code fallback, and the missing/incompatible/degraded/offline/policy-
  denied server paths. Impact recall scored with `assessFactSurvival`
  (`compression-survival.ts:44`) over a known set of caller/impacted files.
- **`codebase-intelligence` profile** — added to `PROFILES`
  (`extension-profiles.ts:48`); generates the tool def + config + policy as plain
  `.otto/` files. Stages stay opt-in; no live injection in this slice.
- Docs: `README.md`, `docs/EXTENSIONS.md`, and the roadmap status line.

**Out of scope (later slice, gated on this spike passing):**

- Injecting bounded graph results into live `plan`/`implementer`/`reviewer`/
  `verifier` prompts (roadmap step 7).
- Indexing a live target / production `codebase-memory` runtime.
- The excluded operations, upstream `install`/`update`, any personal-config
  mutation, and shared/graph-UI artifacts.
- P22 lifecycle retirement of graph payloads in the live loop (the
  `retrievable` classification is designed for now; retirement lands with
  injection).

No new npm dependencies. ESM `.js` relative imports preserved (NodeNext).

## Testable success criteria

Pure/CI (must pass in `pnpm -r test`, no binary):

1. `authorizeToolOperation` allows each read op, allows `index_repository` as the
   sole write op, and blocks every excluded/undeclared op — with a
   `policy-violation` `SafetyEvent` on each block.
2. `classifyIndexFreshness` returns `absent` (no index), `wrong-project`
   (workspace mismatch), `stale` (revision drift / dirty worktree), and `fresh`
   from fixture identities.
3. Write-inventory diffing detects a fixture write outside the declared cache and
   passes when all writes stay inside it.
4. A stubbed `CbmRunner` flows a query through the adapter into a `ToolUsage`
   record carrying `toolVersion`, `indexIdentity`, `indexFreshness`,
   `tokensAvoided`, `latencyMs`, and (on the failure fixtures) `fallbackReason`.
5. `impactRecall` scoring returns exact survived/missing sets for a known
   impacted-file fact set; new `EvalSignals` appear in `compareTrajectories`.
6. `otto-extensions init codebase-intelligence --dry-run` previews the tool def
   (`networkDomains: []`, cache-only `writeRoots`, operations allowlist), config,
   and policy — and mutates nothing.

Gated e2e (`OTTO_CBM_E2E=1` + pinned binary, not CI):

7. The real child completes the `initialize` handshake and answers an
   architecture query; the write inventory of a real scratch `index_repository`
   is recorded; `otto-eval compare cbm-off cbm-on` reports token/tool-call/impact
   deltas from recorded runs.

## Non-goals / risks

- **Do not make graph retrieval the source of truth.** Current source reads and
  tests remain authoritative; graph output is navigation evidence only.
- **Do not run upstream auto-install.** Only a pinned, checksum-verified binary
  through repo-local P19 config + transient runtime state.
- **Do not allow hidden index writes.** Production stays gated until the
  `.codebase-memory/graph.db.zst` and `.gitattributes` side effects are
  suppressed, redirected, or scratch-isolated (proven by the write inventory).
- **Do not enable external tool authority by default.** Off unless the profile is
  applied and stages are opted in — and even then, no live injection this slice.

## Task outline (detailed in the plan)

1. `operations` field + `authorizeToolOperation` (+ tests).
2. `codebase-memory-adapter.ts`: stdio JSON-RPC client + `CbmRunner` +
   `codebaseMemoryToolDefinition()` + availability probe (stubbed tests).
3. Freshness contract + write inventory (+ tests).
4. Evidence fields on `ToolUsage` + run-level index record + context-report
   aggregator (+ tests).
5. Eval signals + `cbm-off`/`cbm-on` configs + fixtures + impact-recall scoring
   (+ tests).
6. `codebase-intelligence` profile + `--dry-run` test.
7. Gated real-binary e2e + docs.
