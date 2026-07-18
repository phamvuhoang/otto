# Spec — P26 Slice 2: Codebase Memory production adapter

Source roadmap: `docs/HARNESS_ROADMAP_PHASE5.md` §P26 (issue
[#198](https://github.com/phamvuhoang/otto/issues/198)), "First P26
Implementation Slice" step 7 (the LATER production adapter). Builds on the P26
spike (PR #206) and its benchmark prerequisites (PR #208).

**Off by default. Enablement is an operator decision, gated on benchmark
evidence — not a code marker.**

## Problem

The P26 spike proved the plumbing (a governed stdio MCP adapter, per-operation
authority, index freshness contract, scratch write inventory, retrieval
evidence, eval signals) but is **report/eval-only**: it never injects graph
results into a live stage, never indexes a live target, and never refreshes.
Slice 2 turns those primitives into a working retrieval path — Otto routes
structural questions through the local code graph before broad grep/read,
injects bounded results into planning/implementation/review/verification, and
keeps the graph fresh — while holding every safety invariant the roadmap set:
graph output navigates but is never authoritative, current source reads and
tests remain the completion gate, writes stay confined, and a missing or stale
graph degrades cleanly to today's behavior.

## Decisions (locked in brainstorming)

1. **Harness-driven injection.** Otto runs a fixed structural query per stage
   and injects the bounded result via the existing `stage-exec` `injectedContext`
   seam. The runtime agent never calls the tool directly (no agent-driven MCP
   exposure, no transient runtime MCP config).
2. **Write confinement = scratch-redirect + inventory-enforce.** Index into an
   Otto-owned scratch dir; verify with the spike's `diffWriteInventory`; any
   escape aborts the index and falls back. No new sandbox.
3. **Source-before-edit = playbook instruction + evidence.** The injected block
   is labeled navigation-only with a "read the actual source before changing it"
   instruction; the existing test/verify gates stay authoritative. No harness
   read-tracking check.
4. **Enablement off-by-default; operator enables.** Code ships inert (profile +
   config `stages`, guarded by freshness/confinement fallbacks). The operator
   turns injection on after acceptable benchmark numbers. No "production-ready"
   code flag.

## Scope

**In scope:**

- **Confined indexing** — `packages/core/src/cbm-index.ts`:
  - `runIndexRepository(runner, { workspaceDir, scratchDir, ... })` runs the
    child with its cache pointed at an Otto-owned scratch dir under `.otto/`,
    snapshots the dir before/after, and runs `diffWriteInventory` against the
    declared write roots.
  - Authorized via `authorizeToolOperation(policy, tool, config, stage,
"index_repository", invocation)` (a write op) before running.
  - **Any escaped write ⇒ abort:** discard the index, return a fallback reason;
    never leave writes outside the declared cache/scratch.
  - On success, capture `CbmIndexIdentity` (workspace, source revision, dirty
    worktree, tool version, index status, indexed-at).
- **Freshness / preflight / refresh** — wired in `loop.ts` (+ a `preflight.ts`
  hook):
  - When the tool is enabled for the run, compute current identity (`git
rev-parse HEAD`, dirty) and `classifyIndexFreshness` against the persisted
    identity. `absent | stale | wrong-project` ⇒ (re)index confined.
  - Refresh after the implementer stage(s), before the reviewer.
  - A non-`fresh` index is never used for injection; degraded refresh ⇒ skip
    injection, fall back, record `fallbackReason`.
  - Record index identity + build/refresh durations in the manifest
    `codebaseMemory` field (already exists).
- **Harness-driven retrieval + injection** — `packages/core/src/cbm-inject.ts`:
  - A per-stage query map: `plan` → architecture / entry points / dependency
    paths / candidate file map; `implementer` → targeted symbol & caller
    discovery for the task; `reviewer`/`verifier` → change-impact / blast-radius
    over the changed files.
  - `buildCbmInjection(stage, ctx, runner, indexIdentity)` runs the stage's
    query via the `CbmRunner`, **bounds** the result to a char/token cap, formats
    a labeled navigation-only block, and returns `{ block, toolUsage }`. Empty /
    degraded / non-fresh ⇒ `{ block: "", toolUsage: { fallbackReason } }`.
  - Injected through the existing `stage-exec.ts` `injectedContext` seam
    (`:180`) — no new prompt-assembly path.
- **P22 lifecycle on graph results:**
  - Map the injected block's tag to `evidence` in `context-report.ts`
    `BLOCK_CATEGORY` so it classifies `retrievable`.
  - Store the full result via `runRetrievalStore`; inject only the bounded
    summary; retire the payload from later iterations; keep the query/index
    handle in `ToolUsage.retrievalHandle`.
  - Evidence via the existing `ToolUsage` fields (sanitized query, tokensAvoided,
    indexFreshness, latency, resultSize, consuming stage, fallbackReason) +
    `summarizeGraphRetrieval` in the context report.
- **Source-before-edit** — an instruction in the injected block header and the
  relevant stage templates (`templates/prompt.md` / stage templates): the graph
  is a navigation map; read current source before changing it; it can be stale
  for dynamic/generated code; tests remain the completion gate.
- **Evidence & eval:**
  - Per-stage injection recorded in `toolsUsed[]`; manifest `codebaseMemory`
    build/refresh timings; `summarizeGraphRetrieval` in the context report; graph
    evidence available to the P24 verification matrix.
  - Extend the `cbm-off` / `cbm-on` configs so `cbm-on` exercises live injection
    (the real benchmark). Add fixtures: post-edit refresh proof, dynamic-code
    fallback, and the missing / degraded / offline / policy-denied paths. A/B
    scored for task success, impact recall, tokens, tool calls, indexing
    overhead, latency.

**Out of scope:**

- Agent-driven MCP tool exposure; transient runtime MCP config; upstream
  `install`/`update`; personal-config mutation; the excluded operations
  (`delete_project`, `manage_adr`, `ingest_traces`, graph UI, shared artifacts).
- A harness read-tracking check for source-before-edit (playbook instruction
  only).
- Default-on behavior — the operator enables injection after the benchmark.
- Any change to a bare run, or a run where the tool is not enabled for a stage.

No new npm dependencies. ESM `.js` relative imports preserved (NodeNext).

## Testable success criteria

Pure/CI (stub `CbmRunner`, no binary):

1. `runIndexRepository` aborts and returns a fallback reason when the write
   inventory shows an escape; succeeds and records `CbmIndexIdentity` when all
   writes stay in scratch.
2. Freshness gating: an `absent|stale|wrong-project` index triggers a (re)index;
   a non-`fresh` index yields no injection and a recorded `fallbackReason`.
3. Per-stage query selection returns the expected operation(s) for `plan` /
   `implementer` / `reviewer` / `verifier`.
4. `buildCbmInjection` bounds an oversized result to the cap, labels it
   navigation-only, and returns a `ToolUsage` with the sanitized query,
   `indexFreshness`, and (on the degraded fixture) `fallbackReason`; a degraded
   runner yields an empty block (no injection).
5. The injected block classifies `retrievable` in the context report and its
   payload is stored via `runRetrievalStore` (handle retained, payload retired).
6. A bare run and a "tool present but stage not enabled" run inject nothing —
   the rendered prompt is byte-for-byte unchanged.
7. `summarizeGraphRetrieval` reflects the per-stage injections in the context
   report; manifest `codebaseMemory` carries build/refresh timings.

Gated e2e (`OTTO_CBM_E2E=1` + pinned binary, not CI):

8. A real confined `index_repository` writes only inside scratch (inventory
   clean); `otto-eval compare cbm-off cbm-on` reports token / tool-call / impact
   deltas with live injection on.

## Non-goals / risks

- **Graph is never authoritative.** Static graphs go stale for dynamic dispatch
  and generated code; current source reads and tests remain the gate.
- **No hidden index writes.** Confinement is enforced by the write inventory;
  an escape aborts rather than proceeds.
- **No silent stale use.** Freshness mismatch always falls back and records why.
- **No default-on / no external authority by default.** Off unless the profile
  is applied, stages are opted in, and the operator enables it.
- **Keep units focused.** Transport (`codebase-memory-adapter.ts`), indexing
  (`cbm-index.ts`), and injection (`cbm-inject.ts`) stay separate so each is
  independently testable.

## Task outline (detailed in the plan)

1. Confined indexing (`cbm-index.ts`: `runIndexRepository` + write-inventory
   abort + identity capture) (+ tests).
2. Freshness orchestration (preflight (re)index + refresh-before-review
   decision logic, pure) (+ tests).
3. Per-stage query map + `buildCbmInjection` (bounding, navigation-only block,
   degraded ⇒ empty) (+ tests).
4. P22 lifecycle: `retrievable` classification + `runRetrievalStore` wiring +
   context-report block category (+ tests).
5. Loop wiring: preflight index, refresh-before-review, per-stage injection via
   `injectedContext`; inert when disabled (+ tests incl. the byte-for-byte
   no-op guard).
6. Source-before-edit template/playbook instruction (+ template test).
7. Eval: `cbm-on` live-injection config + refresh / dynamic-fallback /
   degraded-path fixtures (+ tests).
8. Gated real-binary e2e + docs (EXTENSIONS + roadmap status).
