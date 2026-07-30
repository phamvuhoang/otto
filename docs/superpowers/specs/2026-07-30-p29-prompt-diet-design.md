# Design: P29 — prompt diet (bounded injection, cache shape)

Date: 2026-07-30
Status: Approved (brainstorm, decisions made on the operator's behalf — see [Decisions](#decisions)), pending spec review → plan refresh
Applies to: every entry/stage template that injects `LEARNINGS.md`, the panel lens diff, `ghafk`/`linearafk` intake, and `--token-mode reduce`.
Tracking: issue #247 (epic #245). Roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P29.

## Problem

Per-iteration prompt cost is dominated by repeated static and unbounded content, not task-specific context:

- **`LEARNINGS.md` is `cat`-injected wholesale** — and not in six templates as the roadmap states, but in **13** (see [Scope corrections](#scope-corrections)). `boundLearnings` / `selectRelevantMemory` / `formatBoundedLearnings` (`memory.ts:443`, `:403`, `:471`) and `DEFAULT_LEARNINGS_BUDGET_CHARS = 6000` (`memory.ts:374`) are built, tested, and exported — and called by nothing outside their own tests.
- **The static playbook sits at the end of every entry template.** `afk.md` opens with `{{ RESUME }}`, a `git log` shell tag, the `cat` learnings block, and `{{ INPUTS }}`, then `@include:prompt.md` (the ~400-line static chain) **last** — the worst possible position for prompt-prefix caching.
- **Each panel lens re-spills the same diff.** `review-lens.md:19`, `review.md:25`, and `review-verify.md:19` each carry `@spill?:head.diff=`git show HEAD``, so an N-lens panel runs `git show HEAD` N+1 times.
- **`--token-mode reduce` is cosmetic.** It strips whitespace and hardcodes `cacheHits: 0` (`prompt-reduction.ts:33`) while `compactCommits` (`iteration-compaction.ts`) sits unwired.
- **The compressor's `memory-projection` category is declared but unauthorized.** `CompressionCategory` lists it (`context-compressor.ts:51`) but `isCompressibleCategory` returns true only for `"issue-body"` (`:64`).

## Outcome

Per-iteration prompt cost drops materially at equal benchmark success, by wiring levers that already exist and shaping templates so static content forms a cacheable prefix. Small-`LEARNINGS.md` repos are byte-for-byte unchanged.

## Architecture

- **`memory.ts`** gains a pure resolution rule and an fs wrapper: `resolveLearningsBlock` (byte-parity passthrough under budget; bounded projection from governed records over it; verbatim passthrough when there are no governed records) and `learningsForPrompt`.
- **`stage-exec.ts`** defaults `vars.LEARNINGS` through a `prepareLearnings` step at the single `renderTemplate` call site (`:172`). One wiring point covers the loop, panel substages, and fan-out.
- **Templates** swap the `!?`cat``tag for`{{ LEARNINGS }}`; entry templates are reordered static-first; lens templates take a shared diff path instead of their own `@spill`.
- **`panel.ts`** spills `head.diff` once per iteration into the existing `panelHostDir` (`:429-430`) and shares the path with every substage.
- **`prompt-reduction.ts`** wires `compactCommits` and stops reporting a fabricated cache-hit count.

## Decisions

The operator was remote when this spec was written. Each decision below states its rationale so it can be reversed cheaply.

### D1 — bounded learnings ship as an inline `{{ LEARNINGS }}` var, not a spill

The roadmap suggests both a "harness-rendered bounded block" and routing learnings through a spill so the compressor can act on them. Those pull in opposite directions: a spill moves the block to a file the agent must `Read`, adding a tool round-trip. At a 6000-char budget the block is already small, so a round-trip costs more than the bytes saved. Inline var it is.

### D2 — byte parity under budget; never silently truncate

- `LEARNINGS.md` **under** the 6000-char budget ⇒ inject char-for-char what `!?`cat``produced, including the exact`_No learnings recorded yet._` fallback.
- **Over** budget **with** `.otto/memory/` records ⇒ bounded projection via `boundLearnings`, whose `formatBoundedLearnings` already appends an honest "N learning(s) omitted" note.
- **Over** budget with **no** governed records ⇒ verbatim passthrough. Truncating a hand-written file the harness cannot reconstruct is not an acceptable saving.
- `OTTO_UNBOUNDED_LEARNINGS=1` restores whole-file injection unconditionally.

This makes the change invisible on small repos, which is what keeps it safe to land by default.

### D3 — 13 injection sites exist; the first slice takes six, and that slicing is correct

The **roadmap** says "all six entry templates". The real count is **13** (list below).

The prior plan is not wrong about this: it takes six in its first slice and explicitly names the other seven as deliberately untouched. Its chosen six — `afk.md`, `ghafk.md`, `ghafk-issue.md`, `review.md`, `review-lens.md`, `verify.md` — include `review-lens.md`, which renders once **per lens** and is therefore the single largest win. Keep that slicing; the correction belongs to the roadmap's prose, not the plan's scope.

### D4 — the inert `<issues-summary>` is a bug fix, measured separately

`ghafk.md:17` and `linearafk.md:17` begin with a **bare backtick** — no `!` prefix. Both `SHELL_TRY_TAG` and `SHELL_TAG` (`render.ts:20-21`) require it, so these blocks inject the **literal command string** and never any issue data, while the prose immediately below calls `<issues-summary>` "the lean index for triage".

`docs/ARCHITECTURE.md:313` documents the template as `` !?`gh issue list … --json number,title,labels|||[]` `` — **with** the prefix and the `|||[]` fallback — and `:325` states "the agent triages from the inline `<issues-summary>`". The documentation describes the intended behavior correctly; the template does not implement it. This is a documented-vs-implemented divergence, not a design gap.

The prior plan already found this (its Task 4 is "**Real executed** lean `<issues-summary>`" and it carries a regression test asserting the bare-backtick form is gone). What this spec adds is the measurement consequence below.

Fixing it (adding `!?` plus a `--jq`-leaned projection) **increases** prompt size — it makes a block that currently emits ~100 bytes of command text emit a real 50-issue index. That is still the right call: the index exists so the agent can pick a task without paging a 50-issue JSON spill, and a spill `Read` costs more than the index.

**Because it moves the baseline the wrong way, it is measured separately from the diet.** P29's "≥20% reduction" is reported against a baseline that already includes this fix, so the two effects are never blended.

This is a live correctness bug on `main` affecting two bins and is independent of P29. It should be tracked as its own issue.

### D5 — reorder static-first only after auditing directional language

Moving `@include:prompt.md` to the top is what creates the cacheable prefix, but the playbook chain may contain "the inputs above" / "the diff below" phrasing that silently inverts. The plan carries an explicit audit step over the moved templates and their includes; any directional reference is rewritten to name the block (`<inputs>`) rather than its position. `{{ RESUME }}` moves to immediately **after** the static include so the static block is the true prefix.

### D6 — `memory-projection` compression stays gated on measurement

Authorizing a new compressor category obligates the P22 fact-survival gate (#200) for that category. Since D2 already caps the block at 6000 chars, compressing it further is a small win for a real cost (a `python3` bridge invocation per stage) plus a survival-eval obligation. The plan therefore **measures the bounded block's real size first** and wires compression only if it routinely exceeds ~4000 chars. The category already exists, so enabling it later is additive.

## Scope corrections

The 13 templates that `cat`-inject `LEARNINGS.md` today:

`afk.md`, `apply-review.md`, `ghafk.md`, `ghafk-issue.md`, `linearafk.md`, `linearafk-issue.md`, `plan.md`, `review.md`, `review-lens.md`, `review-synth.md`, `review-verify.md`, `subtask.md`, `verify.md`

Of these, the first slice takes six (D3).

**The roadmap's ghafk-duplication claim is wrong.** It states ghafk "inlines the full 50-issue JSON _and_ spills a second copy". `git log -L 15,19:packages/core/templates/ghafk.md` shows the inline block has been `--json number,title,labels` since the initial public release (`64b6161`) — it was never the full dump, and it does not execute at all (D4). No dedup work is required; the real defect is different, smaller, and in the opposite direction.

`linearafk.md:17` carries the same inert-tag defect and is **not** in the prior plan's Task 4, which covers `ghafk.md` only. The refreshed plan extends that task to both intake templates.

## Data flow

```
executeStage
  → prepareLearnings(workspaceDir, taskKey)
      → learningsForPrompt → resolveLearningsBlock
          under budget      ⇒ verbatim file text (byte parity)
          over + records    ⇒ boundLearnings → formatBoundedLearnings
          over, no records  ⇒ verbatim file text
  → vars.LEARNINGS (default; an explicit caller-supplied var still wins)
  → renderTemplate (stage-exec.ts:172)
      template order: @include static playbook → {{ RESUME }} → dynamic blocks
  → panel only: one head.diff spill per iteration in panelHostDir,
    path shared to every lens/verify substage via {{ DIFF_FILE }}
```

## Error handling

| Condition                                    | Behavior                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| No `.otto/LEARNINGS.md`                      | Exact `_No learnings recorded yet._` fallback, as today.                           |
| No `.otto/memory/` records, file over budget | Verbatim passthrough. Never truncated.                                             |
| Malformed memory record                      | Skipped by the existing `readMemoryRecords` tolerance; never throws into a render. |
| `git show HEAD` fails (no commits)           | Existing `@spill?` fallback semantics preserved (`No diff body`).                  |
| `OTTO_UNBOUNDED_LEARNINGS=1`                 | Bounding disabled entirely.                                                        |

**Render security invariant preserved** (`render.ts:12-17`): no template var ever reaches a shell command body. `{{ LEARNINGS }}` and `{{ DIFF_FILE }}` are substituted into prose positions only; every new or edited shell tag stays a static string.

## Success metrics

- Prompt tokens per stage drop **≥20%** on a mature-repo fixture (large `LEARNINGS.md`, 50-issue backlog) at equal benchmark success, measured against a baseline that already includes the D4 fix.
- Panel lens prompts show **nonzero `cacheReadInputTokens`** on consecutive lenses (`tokens.ts:38` already parses it for the Claude runtime).
- `git show HEAD` runs **once** per panel iteration, not N+1 times.
- Fact-survival eval unchanged (reuses the P22 gate).
- A repo with a small `LEARNINGS.md` renders **byte-for-byte** as before.

## Non-goals

- **No session reuse or cross-stage conversational state.** Prompts are shaped for caching; the fresh-process-per-stage model is untouched.
- **No truncation of hand-written content** (D2).
- **No new compressor authorization without a survival gate** (D6).
- **No new template files.** Templates ship in the tarball; this is edits only.
- **No change to what the agent is asked to do** — only to the order and size of what it is told.

## Dependencies

P7 context telemetry, P20/P22 compressor and survival gates, the `memory.ts` bounded-projection substrate, panel orchestration.

Independent of P27 — no ordering constraint between them; both are NOW.

## Note for maintainers: `memory.ts` is grep-invisible

`memory.ts:221-222` uses **raw NUL (`0x00`) and `0x01` bytes** as `conflictKey` delimiters, written as literal control characters rather than `\x00`/`\x01` escapes. `file(1)` therefore classifies the file as `data`, and `grep`/`ripgrep` skip it silently — no match, no warning. Anyone working the P29 substrate must use `grep -a`.

This is pre-existing and out of P29's scope, but it will waste an implementer's time. Replacing the two raw bytes with escape sequences is behavior-identical and worth doing separately.
