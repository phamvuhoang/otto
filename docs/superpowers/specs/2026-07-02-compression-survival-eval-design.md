# Design — eval-backed fact-survival proof for retrievable compression (P22)

Part of the **Phase 5** roadmap (P22, issue #179). Report/eval-only, no behavior
change.

## Context — what already shipped

Two prior increments landed the ground this builds on:

- **#178** — context-lifecycle reporting: the `evidence → retrievable` category,
  `classifyLifecycle`, `lifecycleRationale`, the freeable-context dry run, and the
  `--context-report` rollup. (The on-disk `.otto/tasks/harness-roadmap-phase5/`
  plan re-planned this as "slice 2, not yet implemented" — it is **stale**; the
  work shipped in #178. This slice's docs correct that.)
- **#193** — real Headroom `compress()` library mode. Because `compressSpill`
  (`stage-exec.ts`) routes every `@spill` through the compressor and
  `spillCategory("issue.json") → "issue-body"`, **retrievable issue bodies are
  already compressed today** when `--context-compressor headroom` is on —
  reversibly, with a `toolsUsed[]` evidence record.

So compression of retrievable content is not missing, and it is already
structurally selective (only spilled content is compressed; the plan/PRD
`<inputs>` and playbook never spill).

## Problem

The roadmap gates trusting (and later expanding) compression on one condition:

> Use Headroom selectively for `retrievable` categories **where eval proves buried
> facts survive compression**.

That eval does not exist. The one real-Headroom test (`OTTO_HEADROOM_E2E=1`,
`headroom-adapter.test.ts`) proves the payload **shrinks** — not that specific
buried facts **survive**. So compression is trusted on faith, which is exactly
what the roadmap forbids. This slice supplies the missing proof.

## Decisions

- **What is the proof?** → A pure fact-survival scorer plus a gated real-Headroom
  e2e over a realistic issue-body fixture. → The scorer gives a deterministic,
  always-in-CI guarantee of the measurement logic; the gated e2e gives the real
  proof against Headroom without forcing a ~600 MB model download in the normal
  suite — the tradeoff #193's e2e already established.
- **What counts as "survives"?** → A normalized, case-insensitive **substring**
  match of the fact in the compressed text. → Buried facts are chosen to be
  distinctive identifiers (error code, semver, file path, config key, a numbered
  acceptance criterion). Substring survival is robust to a summarizer rephrasing
  _around_ a salient token while still catching a token that is dropped.
- **Where does it live?** → A new focused module
  `packages/core/src/compression-survival.ts`, re-exported from `index.ts`. →
  Keeps `context-compressor.ts` (already ~440 lines) focused; survival is an eval
  concern, not part of the live compress path.
- **Does the live loop change?** → **No.** → The runtime compressor has no
  "buried facts" list — survival can only be measured against known facts, which
  is an eval-time input. Nothing runs a stage or mutates a prompt.
- **What does the gated e2e assert?** → (a) the fixture actually compressed (size
  shrank) **and** (b) `survivalRate` is at/above a documented floor. → A failure
  is a deliberate, opt-in signal that compression is unsafe for that content — not
  CI flake, since the block is skipped unless `OTTO_HEADROOM_E2E=1`.

## Scope guard

**In scope:** `assessFactSurvival` + `formatFactSurvival` (pure) and their
deterministic unit tests; a documented issue-body survival fixture; a gated
real-Headroom e2e proving buried facts survive; refreshing the stale
`.otto/tasks/harness-roadmap-phase5/` docs to match reality.

**Out of scope (later slices):** changing what the live loop compresses;
lifecycle-selective compression among spill categories; prior-iteration
retirement; skill/tool context caps; any new bin or flag. No new dependencies;
ESM `.js` import convention preserved.

## File map

Create:

- `packages/core/src/compression-survival.ts` — `FactSurvival` type,
  `assessFactSurvival` (pure), `formatFactSurvival` (pure).
- `packages/core/src/__tests__/compression-survival.test.ts` — deterministic
  scorer/formatter unit tests + the fixture + the gated real-Headroom e2e.

Modify:

- `packages/core/src/index.ts` — re-export the survival symbols.
- `.otto/tasks/harness-roadmap-phase5/{plan,spec,tasks.json}` — replace the stale
  slice-2 content with this slice (slice 2 shipped in #178).

## Testing

Verification: `pnpm -r typecheck && pnpm -r test && pnpm test`. The real-Headroom
proof runs on opt-in only:
`OTTO_HEADROOM_E2E=1 pnpm --filter @phamvuhoang/otto-core test -- compression-survival`.

**Done-when:**

- `assessFactSurvival` returns exact survived/missing/rate for all-survive,
  some-missing, empty-facts, and mixed-case inputs — pinned by unit tests.
- `formatFactSurvival` renders a distinct one-line summary — pinned by a unit test.
- The gated e2e (when opted in) compresses the fixture and asserts size shrank and
  buried facts survive at/above the floor.
- No behavior change: no stage runs, no prompt mutates; the normal suite stays
  green with the e2e skipped.
