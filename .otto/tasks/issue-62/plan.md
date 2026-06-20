# Plan — issue #62: P7 Context & token efficiency

Ordered, bite-sized, testable tasks. One task per Otto run. The issue is Large;
this burns it down telemetry-first, each optimization gated on the prior slice.

- [x] **1. Context telemetry — pure analyzer + formatter.** `context-report.ts`:
  `analyzeContext(prompt): ContextBreakdown` segments a rendered stage prompt into
  `commits` / `learnings` / `inputs` / `playbook`, with chars + `ceil(chars/4)`
  token estimate per category and totals; `formatContextReport` renders a
  human-readable share breakdown. Pure, INERT, exported from `index.ts`. Pinned by
  `context-report.test.ts`.
- [x] **2. Capture the breakdown into the evidence bundle.** Thread the breakdown
  from the rendered prompt in `stage-exec.ts` onto `StageResult` →
  `StageRecord.contextBreakdown?` (optional, absent = none, like `safetyEvents`),
  so each stage record carries its composition. Pinned by `stage-exec.test.ts` /
  `run-report.test.ts`.
- [x] **3. `otto-afk --context-report` read-only surface.** A pure formatter over
  the bundle's stage records (mirrors `otto-runs` / `--explain-routing`); shows
  per-iteration composition + slope. Pinned by `cli-help.test.ts` + a cli test.
- [x] **4. Prompt-prefix caching → cache-hit-rate reporting.** The literal
  "mark a cached prefix" via provider `cache_control` is **not reachable from
  Otto's architecture** — Otto spawns the `claude` CLI (`claude --print`), not the
  Anthropic API, so it cannot inject cache breakpoints; the CLI already caches its
  stable system-prompt/tools automatically and Otto invokes it with identical flags
  each iteration. The feasible, honest half (and the issue's explicit success
  metric) is to **report cache-hit rate**: pure `summarizeCacheEfficiency` /
  `formatCacheEfficiency` over the already-captured per-stage `TokenUsage.cacheRead*`,
  surfaced as a cache-efficiency line on the existing `--context-report`. Pinned by
  `tokens.test.ts` + `context-report-cli.test.ts`.
- [ ] **5. Bounded learnings injection.** Retrieve only task-scope-relevant
  governed-memory records (reuse P3 `select… `/`memory.ts`) instead of the whole
  `LEARNINGS.md`; cap the block and report what was dropped.
- [ ] **6. Inter-iteration compaction.** Summarize prior iterations into a bounded
  state rather than carrying the full transcript forward.
- [ ] **7. Read deduplication.** Track files already read this run; avoid
  re-spilling unchanged content.
- [ ] **8. Per-stage context budget.** A soft, model-aware ceiling that warns and
  triggers compaction when a stage's estimated context exceeds it.

This run implements **task 4**.
