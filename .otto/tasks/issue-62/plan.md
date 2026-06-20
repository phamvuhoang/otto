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
- [x] **5. Bounded learnings injection.** Retrieve only task-scope-relevant
  governed-memory records (reuse P3 `select… `/`memory.ts`) instead of the whole
  `LEARNINGS.md`; cap the block and report what was dropped. Shipped as pure,
  INERT-on-the-loop functions in `memory.ts`: `selectRelevantMemory` ranks active
  records by task-scope relevance (taskKey > repo-wide > other; ties by
  confidence/useCount/recency), `boundLearnings` caps at a char budget
  (`DEFAULT_LEARNINGS_BUDGET_CHARS`) and reports the dropped set, and
  `formatBoundedLearnings` projects the selection with a "what was dropped" note.
  Loop wiring (swapping the whole-file `!?cat LEARNINGS.md` injection for this) is
  deferred to a later slice. Pinned by `memory.test.ts`.
- [x] **6. Inter-iteration compaction.** Summarize prior iterations into a bounded
  state rather than carrying the full transcript forward. Shipped as pure,
  INERT-on-the-loop functions in `iteration-compaction.ts`: the carried-forward
  prior-iteration state in Otto is the `<commits>` block (`git log -n 5
  --format="%H%n%ad%n%B---"`) — count-bounded but body-unbounded. `parseCommitLog`
  parses that format into entries; `compactCommits` keeps the newest commits full
  while cumulative chars stay under `DEFAULT_COMMITS_BUDGET_CHARS` and degrades
  older ones to their subject line (summarized, not dropped), reporting `savedChars`;
  `formatCompactedCommits` re-renders the block with a "what was compacted" note.
  Loop wiring (swapping the template's `!?git log` commit injection for this) is a
  later slice. Pinned by `iteration-compaction.test.ts`.
- [x] **7. Read deduplication.** Track files already read this run; avoid
  re-spilling unchanged content. Shipped as pure, INERT-on-the-loop functions in
  `read-dedup.ts`: a `ReadLedger` (path → fingerprint) carried across iterations;
  `fingerprintContent` (length-prefixed FNV-1a 32-bit, dependency-free) keys the
  ledger; `recordRead` classifies each read as `first`/`unchanged`/`changed`
  (purely, returning a fresh ledger) and reports `savedChars` for an unchanged
  re-read; `summarizeReads` tallies run-level savings; `formatReadReference`
  renders the short "already read, unchanged" line that later replaces a full
  re-spill. Wiring it into the `@spill` path is a later slice. Pinned by
  `read-dedup.test.ts`.
- [x] **8. Per-stage context budget.** A soft, model-aware ceiling that warns and
  triggers compaction when a stage's estimated context exceeds it. Shipped as
  pure, INERT-on-the-loop functions in `context-budget.ts`: `modelContextWindow`
  loosely matches the opaque `OTTO_MODEL` spec to a context window (1M-marker
  aware, conservative default), `modelContextBudget` takes a soft fraction
  (`DEFAULT_CONTEXT_BUDGET_FRACTION`) of it for the inline prompt,
  `assessContextBudget` compares a stage's `ContextBreakdown` (slice 1) estimate
  to the ceiling and — when over — recommends compacting the largest *reducible*
  filler (commits→`compactCommits` slice 6, learnings→`boundLearnings` slice 5;
  inputs/playbook are not P7-reducible), and `formatContextBudget` renders the
  warning. Loop wiring (warn + trigger the levers on overflow) is a later slice.
  Pinned by `context-budget.test.ts`.

This run implements **task 8** (the final P7 substrate task; all six issue scope
items now have pure substrate, and a `fix(review):` propagates the
`--context-report` exit code surfaced in PR #69 review).
