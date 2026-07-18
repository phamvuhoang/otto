# Spec — P30: Context budget enforcement and state digest

Source roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P30 (2026-07-10 audit).
Dependencies: §P29 (prompt diet — wires the bounding levers this ladder pulls)
and the shipped P22 lifecycle + survival evals (#197 fact-survival eval, #200
runtime anchor-survival floor, #202).

**Opt-in enforcement. Default runs stay byte-for-byte unchanged.**

## Problem

The Phase-6 audit's core finding: _"Token-bounding levers exist and are never
called."_ The measurement and the levers are built, tested, and exported — and
nothing in the loop pulls them:

- `assessContextBudget` (`context-budget.ts:114`) is explicitly _"Soft, not a
  gate … Pure + INERT on the loop"_ (docstring `:12-16`). It already knows the
  model windows (`:28-34`, default fraction `0.25` at `:44`) and, when over
  budget, _names_ the lever to pull — `compactCommits` for the commits block,
  `boundLearnings` for the learnings block (`REDUCIBLE_LEVERS`, `:66-69`). Its
  only callers are tests.
- `compactCommits` (`iteration-compaction.ts:93`) and `boundLearnings`
  (`memory.ts:443`, default budget `DEFAULT_LEARNINGS_BUDGET_CHARS = 6000` at
  `:374`) are pure-then-wired substrates whose "wired" half never landed.
- `--token-mode` maxes out at `reduce` (`tokens.ts:1`), which is
  whitespace-only compaction (`prompt-reduction.ts:26`) with `cacheHits`
  hardcoded to 0. There is no tier where an over-budget prompt is _acted on_.
- The `resumeNote` chain is unbounded: the plan-gate failure note concatenates
  the full gate + depth-rubric text (`loop.ts:1036-1041`; other producers at
  `:975` and `:1385`) and is re-injected into **every** stage via the `RESUME`
  var (`loop.ts:1261`, `:1470`; `panel.ts:271/346`). Skills text got a hard
  char budget (`DEFAULT_SKILLS_BUDGET_CHARS = 4000`, `skill-routing.ts:24`);
  the resume chain never did.
- Later iterations re-derive prior-run state from scratch every time — the
  whole `LEARNINGS.md` and the commits block are `cat`/`git log`-injected per
  stage (`templates/afk.md:3-13`) — even though P22's lifecycle work showed
  most late-run context is stale evidence and the run bundle already holds the
  authoritative record (`.otto/runs/<run-id>/`).

P22 shipped the missing precondition: a CI-runnable fact-survival scorer
(`assessFactSurvival`, `compression-survival.ts:42`) and a runtime
anchor-survival floor on the compressor keep-decision (#200:
`isCompressibleCategory` + `SURVIVAL_FLOOR = 0.9` in `assembleOutput`,
`extractAnchors` in `compression-survival.ts`). "Do not compress or retire
without evidence" is now a satisfiable gate.

## Goal

When a stage's assembled context exceeds its budget, degrade it through
governed, recorded levers instead of shipping it anyway; retire stale
re-derived state into a compact harness-written digest — so long-run token
slope flattens into the P22 band — while a run without the opt-in remains
byte-for-byte identical to today.

## Decisions (locked in brainstorming)

1. **Enforcement is a `TokenMode` tier, not a new flag.** `enforce` extends
   `off|measure|reduce` (`tokens.ts:1`, `parseTokenMode` `:118-130`), resolved
   flag → `OTTO_TOKEN_MODE` → `.otto/config.json` `tokenMode` → off (the
   config leg is new, mirroring `readCompressorMode`'s typo-safe resolution).
   `enforce` ⊇ `measure` (token accounting on) and applies `reduce`'s free
   whitespace compaction before the ladder.
2. **The enforcement point is `stage-exec.ts`, between render and spawn**
   (`executeStage`, the region `:153-209` where the final prompt string
   exists). Levers rewrite only the recognized blocks `analyzeContext` already
   attributes (`BLOCK_CATEGORY`, `context-report.ts:58-69`): `<learnings>`,
   the evidence tags (`<issue>`/`<issues-summary>`/`<issues-full-file>`), and
   `<commits>`. **`<inputs>` (the task source) and the playbook/policy text
   are never touched — there is no silent-truncation path.** Panel substages
   run through the same `executeStage`, so the self-contained levers cover
   them for free.
3. **Fixed ladder order, re-assessed between rungs, stop when under budget:**
   (a) tighter `boundLearnings` budget (halve the active budget; default
   6000 → 3000), (b) reversible compression of retrievable evidence blocks via
   the existing compressor seam (`compressContentSync`,
   `context-compressor.ts:306` — the #200 anchor-survival floor and the
   retrieval store apply unchanged), (c) `compactCommits` on the commits
   block. Every application — including a zero-saving one — is recorded as a
   `ContextEnforcementEvent { lever; beforeTokens; afterTokens; stage }` on
   the stage record and aggregated on the manifest (the `inputSharpness`
   optional-field pattern, `run-report.ts:178`).
4. **The learnings lever never cuts what it cannot re-derive.** It runs only
   through a hook that re-renders the block from governed `.otto/memory/`
   records (`readMemoryRecords` `memory.ts:529` → `boundLearnings` `:443` →
   `formatBoundedLearnings` `:471`). No records ⇒ the lever is skipped — a
   legacy `cat`-injected `LEARNINGS.md` is never blindly truncated. **P29
   dependency, stated explicitly:** P29 converts learnings injection to a
   harness-rendered `{{ LEARNINGS }}` and wires `boundLearnings` as the
   normal path; P30's rung (a) is "the same wired lever at half budget". The
   ladder is buildable against the substrate today, but its budget baseline
   and the `memory-projection` compression category assume P29 lands first.
5. **The state digest is harness-written, bounded, and rides the existing
   `RESUME` var** — no template changes. Built per iteration from run evidence
   (commit subjects since run start, inputs focus, latest `reviewSeverity`
   findings, last verification/attested-check state _if present_, and the
   run-bundle evidence path), written to `.otto/runs/<run-id>/state-digest.md`
   for inspection, and prepended to the resume note on later iterations.
   Active only in `enforce` mode. Originals stay retrievable via run-bundle
   paths (stage `logPath`s, `compressed/*.orig` retrieval handles) — the
   digest is navigation, never the source of truth.
6. **The resume chain gets the skills-block treatment:**
   `RESUME_NOTE_MAX_CHARS = 2000`, head-preserving truncation with an elision
   marker, applied when composing the `RESUME` var **in enforce mode only**
   (so default runs stay byte-for-byte).
7. **Gate before trust (P22).** Enforcement ships with CI fact-survival
   fixtures (`assessFactSurvival`) for every category it touches — bounded
   learnings at the halved budget and the state digest — failing them fails
   `pnpm -r test`. The compress rung additionally inherits the #200 runtime
   floor per application. Note: #200 currently sits on
   `fix/phase5-review-findings`; P30 assumes it is merged (the roadmap records
   it as shipped).

## Scope

**In scope:**

- `enforce` tier: `TokenMode` + `parseTokenMode` (`tokens.ts`), a
  `readConfigTokenMode` config leg, `run-bin.ts:169-180` resolution, and the
  `--token-mode` usage line (`cli-help.ts:574`).
- `packages/core/src/context-enforcement.ts` (new, pure): the ladder
  (`enforceContextBudget`), `ContextEnforcementEvent`, injected lever hooks,
  `summarizeEnforcement`, `boundResumeNote` + `RESUME_NOTE_MAX_CHARS`, and
  `composeResume`. Consumes `assessContextBudget`, `analyzeContext`,
  `parseCommitLog`/`compactCommits`/`formatCompactedCommits` unchanged.
- `stage-exec.ts` wiring: budget assessment attached in measure+enforce, the
  ladder in enforce; `StageResult` (`runner.ts:44`) and `StageRecord`/
  `RunManifest` (`run-report.ts:114/150`) gain optional `contextBudget` /
  `contextEnforcement` evidence fields.
- `loop.ts` wiring: the memory-backed learnings hook, event aggregation onto
  the manifest in `finalizeManifest` (`:771`), and the bounded
  digest-plus-note `RESUME` composition at the three injection sites
  (`:1261`, `:1470`, panel `:1233`).
- `packages/core/src/state-digest.ts` (new): `buildStateDigest` (pure) +
  `commitSubjectsSince`; per-iteration write into the run bundle.
- Context report (`context-report-cli.ts:62`): an **Enforced** section (one
  line per event with its measured saving) and an **Advisory** section
  (over-budget measure-mode stages naming the un-pulled lever).
- Eval/gate: fact-survival fixtures for bounded learnings + digest; a
  CI-runnable long-run fixture proving the last-third/first-third token band
  (the report's existing ±10% slope band, `context-report-cli.ts:100-112`).
- Docs: `README.md`, `docs/CLI.md`, roadmap status line.

**Out of scope (other initiatives, explicitly):**

- P29's diet itself: the `{{ LEARNINGS }}` template conversion, ghafk payload
  dedup, static-first reordering, cache shaping, and making `reduce` honest.
- P27 attested checks — the digest carries check state only _if present_
  (today: the P24 verification matrix on `--verify` runs).
- Enforcing on `inputs`/`playbook`, changing model windows or the 0.25
  fraction default, session reuse, or any new per-stage budget config surface
  beyond the existing `fraction`/`maxTokens` inputs.
- Live benchmark A/B (`otto-eval`) runs — recorded-run comparison stays the
  operator workflow; CI carries the pure fixtures.

No new npm dependencies. ESM `.js` relative imports preserved (NodeNext).

## Testable success criteria

Pure/CI (must pass in `pnpm -r test`):

1. `parseTokenMode("enforce")` parses; the rejection message names all four
   modes; `readConfigTokenMode` resolves `.otto/config.json` and degrades a
   typo to `off`; flag > env > config precedence holds.
2. On an over-budget fixture prompt the ladder applies (a) → (b) → (c) in
   order, re-assesses between rungs, stops at the first under-budget
   re-assessment, and records one event per application with before/after
   estimated tokens (`ceil(chars/4)`, `context-report.ts:48`) and the stage.
3. The `<inputs>` block and playbook text are byte-identical before and after
   enforcement, on every fixture.
4. The learnings rung is skipped (no event, block untouched) when the hook is
   absent or returns null — no blind cut of un-re-derivable text.
5. The compress rung stores originals via the retrieval store, attaches
   compression `ToolUsage` evidence, and leaves the block verbatim on a
   degraded/non-shrinking result.
6. A resume note over 2000 chars is head-preserved with an elision marker in
   enforce mode and untouched in off/measure/reduce.
7. `buildStateDigest` output is ≤ `STATE_DIGEST_MAX_CHARS`, survives its
   fixture facts (task key, changed path, finding token) at rate 1 under
   `assessFactSurvival`, and cites the `.otto/runs/<run-id>/` evidence path.
8. Stage records carry `contextBudget` (measure+enforce) and
   `contextEnforcement` (enforce, when events fired); the manifest carries
   the aggregated summary only when events occurred; the context report
   renders Enforced lines with measured savings and Advisory lines for
   over-budget unenforced stages — and neither section on a clean run.
9. Long-run fixture: nine growing iteration prompts whose raw token estimate
   grows >20% first-third → last-third flatten, under enforcement, to a
   last-third average within +10% of the first third (the report's band).
10. Byte-for-byte default: with `--token-mode` off (and measure/reduce), the
    prompt sent to `runStage` and all record/manifest shapes are unchanged —
    existing stage-exec/loop tests stay green untouched.

Operator-verified (not CI): no benchmark regression with enforcement on
(`otto-eval compare` over recorded runs), and a real long AFK run showing the
flattened slope in `--context-report`.

## Non-goals / risks

- **Do not enforce by silent truncation** (roadmap risk, verbatim). Every byte
  removed traces to a recorded lever event; inputs and policy content are
  structurally unreachable by the ladder.
- **Do not make the digest the source of truth.** It cites run-bundle paths;
  reviewers and evals read the originals.
- **Do not flip the default.** Measure-only remains the default; `enforce` is
  flag/env/config opt-in, and the digest exists only under it.
- **Honest about weak rungs.** Default templates inject subject-only commits
  (`--format="%H%n%ad%n%s---"`, `templates/afk.md:5`), so rung (c) often saves
  little there — its events stay visible (zero-saving applications included)
  rather than being suppressed; the rung earns its keep on verbose bodies and
  the `-n 15` templates (`plan.md`/`verify.md`/`apply-review.md`).
- **Sequencing risk:** rung (a)'s baseline and rung (b)'s
  `memory-projection` category assume P29 and #200 merge first; the ladder
  degrades cleanly (skipped rungs, recorded) if they slip.

## Task outline (detailed in the plan)

1. `enforce` token-mode tier: type + parse + config leg + CLI text (+ tests).
2. `context-enforcement.ts`: ladder + events + `boundResumeNote` +
   `summarizeEnforcement` (+ tests).
3. Enforcement point in `stage-exec.ts` + evidence fields on
   `StageResult`/`StageRecord`/`RunManifest` (+ tests).
4. Loop wiring: memory-backed learnings hook, manifest aggregation, bounded
   `RESUME` composition via `composeResume` (+ tests).
5. `state-digest.ts` + per-iteration write + injection + digest survival
   fixture (+ tests).
6. Context report: Enforced vs Advisory sections (+ tests).
7. Long-run flattening fixture + bounded-learnings survival gate + docs.
