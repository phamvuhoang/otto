# Spec — P29: Prompt diet — bounded injection and cache-shaped templates

Source roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P29 ("Prompt Diet — Bounded
Injection And Cache-Shaped Templates"). Audit findings re-verified against
source on 2026-07-10.

**Wiring existing levers. One justified default change (bounded learnings),
with a byte-parity floor and an `OTTO_UNBOUNDED_LEARNINGS=1` escape hatch.**

## Problem

The dominant per-iteration prompt cost is repeated static and unbounded
content, not task-specific context. Every lever needed to fix it already
exists in the codebase — built, tested, exported, and unwired:

- **Unbounded learnings, re-injected everywhere.** Thirteen templates carry
  `` !?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._` `` (e.g.
  `afk.md:11`, `ghafk.md:11`, `ghafk-issue.md:9`, `review.md:17`,
  `review-lens.md:11`, `verify.md:11`), so a mature repo's whole learnings
  file rides in **every** stage prompt — including all panel lenses — every
  iteration. Meanwhile `memory.ts` ships the complete bounded-injection
  substrate: `DEFAULT_LEARNINGS_BUDGET_CHARS = 6000` (`memory.ts:374`),
  `selectRelevantMemory` (`:403`), `boundLearnings` (`:443`),
  `formatBoundedLearnings` (`:471`) — exported from `index.ts:216-229`,
  consumed by nothing but its own tests.
- **The ghafk "lean index" is not real.** `docs/ARCHITECTURE.md:302-313`
  documents a two-view issue model with an _executed_ `!?` inline summary.
  The actual `ghafk.md:17` command has **no `!` prefix** — `render.ts`'s
  `SHELL_TRY_TAG`/`SHELL_TAG` (`render.ts:20-21`) never match it, so the
  "summary" renders as a literal backticked command the agent must run
  itself: an unmeasured, uncacheable, per-iteration tool call whose full
  output lands in the transcript. The full dump _is_ spilled correctly at
  `ghafk.md:23`.
- **The review diff is spilled once per lens, not per iteration.**
  `review-lens.md:19` carries `` @spill?:head.diff=`git show HEAD` ``; each
  lens's `executeStage` gets a unique spill dir
  (`spill-<pid>-<iter>-<label>-<Date.now()>`, `stage-exec.ts:118`), so a
  4-lens panel runs `git show HEAD` four times and — worse for caching — each
  lens prompt diverges at the spill _path_, killing any shared prefix.
- **Templates are shaped dynamic-first.** Entry templates put `{{ RESUME }}`,
  commits, learnings, and inputs _before_ the `@include`d playbook chain
  (`prompt.md` + `superpowers.md` + `governed-memory.md` +
  `quality-report.md`, ~400 static lines), so the static bulk never forms a
  stable cacheable prefix. The runner already parses cache reads
  (`tokens.ts:38` `cache_read_input_tokens`; Codex twin `runner.ts:110`) —
  there is measurement, but nothing shaped to be measured.
- **Two compressor categories are dead.** `COMPRESSION_CATEGORIES` declares
  `memory-projection` and `prior-iteration` (`context-compressor.ts:45-52`),
  but `spillCategory` (`stage-exec.ts:69-81`) can only ever produce
  `issue-body`/`command-log`/`read-artifact` — learnings never reach the
  compressor at all because they are inlined by a `!?` tag, not a spill.
- **`--token-mode reduce` is dishonest.** `applyPromptReduction`
  (`prompt-reduction.ts:26-37`) only compacts whitespace and reports a
  hardcoded `cacheHits: 0`; `compactCommits`/`formatCompactedCommits`
  (`iteration-compaction.ts:93/:130`, budget 2400 chars) shipped
  pure-then-wired like `boundLearnings` and were likewise never wired.

## Goal

Cut per-iteration prompt tokens ≥20% on a mature-repo fixture at equal
benchmark success, make consecutive panel-lens prompts share a cacheable
prefix, and make `--token-mode reduce` report what it actually does — by
wiring the existing levers, with small-`LEARNINGS.md` repos byte-identical
and a survival test proving bounded selection drops no load-bearing fact.

## Decisions (locked in brainstorming)

1. **Harness-rendered `{{ LEARNINGS }}`, computed in `executeStage`.** The
   bounded text is resolved once per stage attempt and substituted via the
   generic-var pass (`render.ts:213`), keeping the learnings block shell-free.
   One wiring point covers the loop, panel substages, and fan-out; a
   caller-supplied `vars.LEARNINGS` wins. The `<learnings>` tag wrapper stays
   in the templates — the playbooks reference it by name.
2. **Byte parity when under budget.** If the raw file fits the 6000-char
   budget the injected text is byte-identical to today's `!?` output —
   including the try-shell's trailing-newline trim (`render.ts:191`) and the
   exact `_No learnings recorded yet._` fallback. This is what makes the
   default change safe: small repos cannot observe it.
3. **Never silently truncate a hand-maintained file.** Over budget with zero
   governed records (`.otto/memory/` empty), the raw file passes through
   verbatim — bounding requires the governed substrate to select from.
   Bounded output uses `formatBoundedLearnings`, which already appends an
   honest "N learnings omitted" note. `OTTO_UNBOUNDED_LEARNINGS=1` restores
   whole-file injection unconditionally.
4. **ghafk summary becomes a real executed lean index.** The literal command
   at `ghafk.md:17` gains the missing `!?` and a `|||[]` fallback, and shrinks
   the payload with gh's built-in `--jq` (no new dependency) to
   `number`/`title`/label **names** — full label objects (color, description,
   ids) are triage noise. The full dump spill (`issue-body` category, already
   compressor-eligible) is unchanged: the fat payload exists exactly once.
5. **One diff spill per iteration, shared across lenses.** `panel.ts` writes
   `head.diff` into the existing per-iteration `panelHostDir`
   (`panel.ts:223-225`) once, before the lens fan-out (`panel.ts:268-284`),
   and passes the path as a `DIFF_FILE` template var. With learnings and diff
   path identical across lenses, every lens prompt is identical up to the
   `# REVIEWER — {{ LENS }} lens` marker — the prefix cache reads are shaped
   to hit.
6. **Static-first reorder scoped to the three GitHub/plan entry templates**
   (`afk.md`, `ghafk.md`, `ghafk-issue.md`) whose `@include` playbook chains
   are the ~400-line static bulk; positional wording in `prompt.md:3` /
   `ghprompt.md:3` flips from "start of context" to "end of context".
   `review.md`/`verify.md`/linear templates and `review-lens.md` keep their
   order this slice (the lens cache win comes from decision 5, and reordering
   `review-lens.md` would pull `{{ LENS }}` _earlier_, shrinking the shared
   prefix).
7. **`memory-projection` is fed at the var boundary, not via a literal
   `@spill`.** `@spill` substitutes a _file path_; learnings must stay inline
   for the `<learnings>` contract the playbooks reference. `executeStage`
   routes the resolved learnings text through the same `compressContentSync`
   orchestrator the spill hook uses (`context-compressor.ts:306`), with
   category `memory-projection`, the run's retrieval store, and a
   `compressionToolUsage` evidence record — same reversibility, same
   discard-unless-it-shrinks floor (`context-compressor.ts:216`). Off unless
   `--context-compressor headroom` is on, like every spill compression.
8. **`--token-mode reduce` wires real levers** (the locked pick over
   renaming): the `<commits>` block is compacted via
   `parseCommitLog`/`compactCommits`/`formatCompactedCommits`, and
   `PromptReductionStats` drops the fake `cacheHits`/`cacheMisses` for
   measured `whitespaceSavedChars`/`commitsSavedChars`.

## Scope

**In scope:**

- `packages/core/src/memory.ts`: `LEARNINGS_FALLBACK`, pure
  `resolveLearningsBlock(raw, records, ctx)` (parity/bounding rules above),
  impure `learningsForPrompt(workspaceDir, ctx, env)` (reads
  `.otto/LEARNINGS.md` + `readMemoryRecords`, honors
  `OTTO_UNBOUNDED_LEARNINGS`); exports via `index.ts`.
- `packages/core/src/stage-exec.ts`: `prepareLearnings(...)` — resolve +
  optionally compress (`memory-projection`) + `ToolUsage` evidence — called in
  `executeStage` to default `vars.LEARNINGS` (caller override wins).
- Templates (all ship in the tarball as today): `<learnings>` bodies of
  `afk.md`, `ghafk.md`, `ghafk-issue.md`, `review.md`, `review-lens.md`,
  `verify.md` → `{{ LEARNINGS }}`; `ghafk.md` `<issues-summary>` → executed
  lean `!?` index; `review-lens.md:19` → `{{ DIFF_FILE }}`; static-first
  reorder of `afk.md`/`ghafk.md`/`ghafk-issue.md` + positional wording in
  `prompt.md`/`ghprompt.md`/`ghafk-issue.md`.
- `packages/core/src/panel.ts`: `spillHeadDiff(workspaceDir, panelHostDir)`
  helper; `DIFF_FILE` threaded into lens vars (`panel.ts:271`).
- `packages/core/src/prompt-reduction.ts`: commits compaction + honest stats;
  matching stderr line in `stage-exec.ts:165-172`.
- Tests: new `learnings-bound`, `prepare-learnings`, `panel-diff-spill`,
  `template-order`, `prompt-diet-proof` suites; updates to `learnings`,
  `ghafk-templates`, `review-lens`, `prompt-reduction` suites.
- Docs: `README.md` (escape hatch + honest reduce), `docs/ARCHITECTURE.md`
  (fix the `<issues-summary>` drift), roadmap status line.

**Out of scope (follow-ups, cheap once `{{ LEARNINGS }}` exists):**

- The remaining seven `cat LEARNINGS.md` templates (`plan.md:11`,
  `apply-review.md:11`, `linearafk.md:11`, `linearafk-issue.md:9`,
  `review-verify.md:11`, `review-synth.md:11`, `subtask.md:5`).
- Static-first reorder of `review.md`/`verify.md`/linear entry templates
  (decide after cache-read telemetry from this slice).
- Threading the compressor into `runPanel` (loop.ts:1221-1244 does not pass
  it today; unchanged).
- Producing the `prior-iteration` compressor category (P30 territory —
  commits are _compacted_ here, not compressed).
- Any live A/B benchmark run (the CI proof is render-level; `otto-eval`
  compare on recorded runs is the operator workflow).
- New config knobs beyond `OTTO_UNBOUNDED_LEARNINGS` (budget stays the
  substrate default).

No new npm dependencies (`--jq` is built into `gh`). ESM `.js` relative
imports preserved (NodeNext). Fresh-process-per-stage model untouched
(roadmap "do not regress" constraint).

## Testable success criteria

All pure/CI (must pass in `pnpm -r test`; no live agent, no gh network —
render tests use temp workspaces and template-text assertions):

1. `resolveLearningsBlock`: byte-identical passthrough under budget
   (trailing newline trimmed, exact fallback string when the file is
   absent); bounded projection with the omission note when over budget with
   records; verbatim passthrough when over budget without records;
   `unbounded: true` always verbatim.
2. `prepareLearnings`: with a stub `SyncContextCompressor` it emits a
   `ToolUsage` whose reasons attribute `memory-projection` and stores the
   original via the retrieval store; a non-shrinking stub degrades to the
   original with no retrieval handle; compressor off ⇒ plain resolution, no
   usage record.
3. Rendered `afk.md` against a workspace whose `LEARNINGS.md` is small is
   char-for-char identical in its `<learnings>` block to today's `cat`
   injection; with `OTTO_UNBOUNDED_LEARNINGS=1` a large file also injects
   whole.
4. **Diet proof:** rendered `afk.md` against a mature fixture (>24k-char
   `LEARNINGS.md`, governed records) is ≥20% smaller than the unbounded
   render, and every planted high-relevance fact survives per
   `assessFactSurvival` (`compression-survival.ts:42`) — survival rate 1.0.
5. `ghafk.md`'s `<issues-summary>` body is a `!?` tag with the `|||[]`
   fallback, lean `--json number,title,labels` + `--jq` label-name mapping,
   and the existing `ghafk-templates` security/scope invariants still pass
   (scope fragment present, no `{{` in shell bodies, only validated env
   vars).
6. Two lens renders of `review-lens.md` in one panel iteration share an
   identical prompt prefix through the `<latest-diff>` block (same
   `DIFF_FILE` path, no `@spill` tag left), and `spillHeadDiff` writes
   exactly one `head.diff` whose content is the `git show HEAD` patch (or
   the documented fallback with no commits).
7. Rendered `afk.md`/`ghafk.md`/`ghafk-issue.md` place the playbook chain
   before the first dynamic block (`<commits>`), and `{{ RESUME }}`/inputs
   after it; the `learnings`/`ghafk-templates` suites still pass on the
   reordered files.
8. `applyPromptReduction` compacts a `<commits>` block over the 2400-char
   budget to subject-only older entries with the honest note, never alters a
   block under budget, and its stats expose
   `whitespaceSavedChars`/`commitsSavedChars` (no `cacheHits`).

Operator-verified (not CI): nonzero `cacheReadInputTokens` on consecutive
panel lenses in a recorded run (`otto-inspect`), and the ≥20% drop at equal
success on a real mature repo via `otto-eval compare` — the roadmap metrics
this slice shapes for.

## Non-goals / risks

- **Do not regress fresh-process-per-stage.** Prompts are shaped and bounded;
  no transcript is carried across stages.
- **Do not bound without governance.** A hand-maintained `LEARNINGS.md` with
  no `.otto/memory/` records is never truncated — the diet on such repos
  comes only from the other levers.
- **Cache reads are opportunistic, not guaranteed.** Lenses run concurrently
  (`LENS_CONCURRENCY = 4`, `panel.ts:83`), so the first requests race the
  cache write; the criterion is _shaped identical prefixes_ (CI-testable) plus
  observed nonzero reads on recorded runs (operator-verified).
- **Do not double-fetch semantics.** The ghafk change keeps two `gh` calls
  (lean index + full dump) — the _payload_ is deduped, not the network call;
  collapsing to one call would need dynamic command bodies, which the
  render-security invariant (`render.ts:12-17`) forbids.
- **`compressionToolUsage` stays Headroom-named** — the evidence record's
  `reasons` carry the category; no schema change this slice.

## Task outline (detailed in the plan)

1. `memory.ts`: `LEARNINGS_FALLBACK` + `resolveLearningsBlock` +
   `learningsForPrompt` (+ tests).
2. `stage-exec.ts`: `prepareLearnings` + `executeStage` wiring, feeding
   `memory-projection` (+ tests).
3. Swap the six templates' `<learnings>` bodies to `{{ LEARNINGS }}`
   (+ update `learnings.test.ts`).
4. ghafk executed lean `<issues-summary>` (+ `ghafk-templates` additions).
5. Shared panel diff spill: `spillHeadDiff` + `DIFF_FILE`
   (+ tests, `review-lens.test.ts` update).
6. Static-first reorder of `afk.md`/`ghafk.md`/`ghafk-issue.md` + playbook
   wording (+ order tests).
7. Honest `--token-mode reduce`: commits compaction + real stats (+ tests).
8. Diet-proof test (≥20% + fact survival + small-repo parity) + docs +
   roadmap status; full verify.
