# Otto Harness Roadmap — Phase 6: Attested Outcomes, Bounded Context

Last updated: 2026-07-18

> **Status:** Planned. No P27–P31 initiative has an implementation slice yet —
> this update does not claim any of them shipped. **P32 (automated
> pull-request code review) is an URGENT PARALLEL initiative that has
> shipped** alongside this backlog, not a renumbering or reordering of
> P27–P31: it addressed a separate, higher-urgency need (unattended PR review)
> and was pulled forward and built end-to-end while P27–P31 remained planned.
> Tracking: epic and per-initiative GitHub issues to be filed when the first
> P27–P31 slice starts.

Phase 1 ([`HARNESS_ENHANCEMENT_ROADMAP.md`](./HARNESS_ENHANCEMENT_ROADMAP.md),
P0–P6) made Otto governed, measurable, and adaptive. Phase 2
([`HARNESS_ROADMAP_PHASE2.md`](./HARNESS_ROADMAP_PHASE2.md), P7–P12) made it
efficient, legible, generative, and multi-agent. Phase 3
([`HARNESS_ROADMAP_PHASE3.md`](./HARNESS_ROADMAP_PHASE3.md), P13–P15) made its
plan, review, and report gates judge substance. Phase 4
([`HARNESS_ROADMAP_PHASE4.md`](./HARNESS_ROADMAP_PHASE4.md), P16–P21) made
skills, tools, compression, and extension profiles governed and inspectable.
Phase 5 (P22–P26) made existing power useful: context lifecycle, input
sharpening, artifact-backed verification, and the structural-retrieval and
coordination bets.

Phase 6 closes the gap between what Otto _records_ and what Otto _knows_. A
full audit of the loop, templates, and evidence pipeline (2026-07-10) found one
repeating pattern: the machinery for trust and efficiency exists but is inert,
while the load-bearing claims are still taken on faith:

- **Every test/typecheck/build outcome in every review path is agent
  self-reported.** The harness never executes a check itself outside the eval
  suite (`bench.ts` `runFixtureChecks` is eval-only). A `fix(review):` commit
  is accepted on the agent's word that suites passed.
- **Regression detection is wired inert.** `progress.ts` defines
  `failingChecks`, `failureSignature`, and `findingSignatures`, but the loop
  hardcodes them to `null`/empty (`loop.ts`), so adaptive iteration control is
  effectively a stall detector.
- **Token-bounding levers exist and are never called.** `boundLearnings`
  (`memory.ts`), `compactCommits` (`iteration-compaction.ts`), and
  `assessContextBudget` (`context-budget.ts`) are built, tested, exported — and
  unwired. Every stage re-injects the whole `LEARNINGS.md`, a ~400-line static
  playbook chain, and (for ghafk) the same 50-issue JSON twice.
- **The plan gate measures shape, not soundness.** Both rubrics are
  keyword/regex heuristics; AFK auto-approves; the parsed "edit" checkpoint
  decision is a dead path that behaves exactly like "reject".

**Thesis for Phase 6:** an unattended run should be _cheap to keep alive and
expensive to fool_. Attest outcomes with harness-executed checks instead of
agent prose, feed those attested signals into iteration control, wire the
already-built context levers so long runs stay inside a governed budget, and
gate plans on substance with a human path that actually works.

## Product And Research Inputs

- The 2026-07-10 codebase audit (loop, renderer, templates, panel, plan gate,
  reports, eval) — every initiative below cites its concrete findings.
- P22 shipped the missing precondition for enforcement: a CI-runnable
  fact-survival eval (#197/#202) and an anchor-survival floor (#200). "Do not
  compress or retire without evidence" is now a satisfiable gate, not a
  blocker.
- P24 shipped the verification matrix with machine-checked artifact
  _existence_; Phase 6 extends the same philosophy from "the artifact exists"
  to "the harness watched the check pass".
- P25/P26 (planned) get stronger, not weaker, from this phase: P25's
  contribution evidence and merge decisions gain harness-attested check
  results; P26's efficiency thresholds gain a cheaper baseline to beat.
- Anthropic's prompt-caching economics reward stable prompt prefixes; Otto's
  renderer currently interleaves dynamic content ahead of static playbooks and
  never shapes a cacheable prefix.

## Strategy Context

### Business And Product Outcomes

| Outcome                       | Why it matters                                                               | Candidate metric                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Verified-not-trusted outcomes | Merge trust requires proof the harness observed, not prose the agent wrote.  | % fix commits with harness-attested checks; self-report/attested disagreement    |
| Cheaper iterations            | Long unattended runs are constrained by per-iteration prompt cost.           | prompt tokens per stage; injected-context bytes; cache-hit share on panel lenses |
| Bounded long runs             | Token growth must flatten instead of compounding across iterations.          | last-third vs first-third token band; over-budget stages auto-remediated         |
| Less review churn             | Re-raised findings and undetected regressions burn iterations.               | re-raised finding rate; regressions caught before the next implement stage       |
| Plans worth approving         | A gate that keyword-stuffing can pass wastes the re-plan and the human's 2m. | semantic judge pass rate vs rubric-only; human edit adoption; scope-drift rate   |

### Target Users

- Solo maintainers running Otto AFK overnight who need to trust "tests green"
  in the morning report without re-running everything.
- Teams whose repos have grown `LEARNINGS.md` and issue backlogs large enough
  that per-iteration prompt cost dominates run budgets.
- Operators using `--review-panel`/`--adaptive-router` who need iteration
  control to react to failing checks and recurring findings, not just stalls.
- PMs and founders using `--plan` who need the checkpoint to be a real
  decision point with a working edit path.

## Current Position

- `runner.ts` spawns a fresh CLI per stage (good isolation, no conversational
  accumulation), but re-derived inputs grow monotonically: `LEARNINGS.md` is
  `cat`-injected wholesale in all six entry templates; ghafk inlines the full
  50-issue JSON _and_ spills a second copy; panel lenses each re-spill the same
  `git show HEAD`.
- `context-budget.ts` and `context-report.ts` are explicitly "pure + INERT on
  the loop": they measure and recommend, nothing enforces. `--token-mode
reduce` only strips whitespace and hardcodes `cacheHits: 0`.
- The panel enforces read-only lenses only when the worktree started
  tracked-clean; verdict counts are display-only; `reviewSeverity` report
  totals are taken pre-verifier, so REJECTED findings inflate them.
- `verification-matrix.ts` validates artifact existence rigorously, but a
  `method:"test", result:"pass"` row is never re-executed.
- The plan checkpoint parses approve/edit/reject and collapses edit into
  pause; sharpening (`--sharpen-input`) is advisory-only in all modes; the
  plan gate is otto-afk-only.

## Prioritized Initiatives

| Priority | Initiative                                                                     | Outcome                                                                                                                           | Size   | Confidence |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| P27      | Harness-attested feedback loops                                                | Test/typecheck/build outcomes are executed and recorded by the harness.                                                           | Medium | High       |
| P29      | Prompt diet: bounded injection, cache shape                                    | Cut per-iteration prompt cost by wiring built levers and deduping payloads.                                                       | Medium | High       |
| P28      | Regression signals and review integrity                                        | Iteration control reacts to attested failures and recurring findings.                                                             | Medium | High       |
| P30      | Context budget enforcement and state digest                                    | Over-budget context degrades through governed levers; stale context retires.                                                      | Medium | Medium     |
| P31      | Plan soundness and a working human loop                                        | Plans are judged on substance and the checkpoint edit path works.                                                                 | Large  | Medium     |
| **P32**  | **Automated pull-request code review (urgent, PARALLEL to P27–P31 — shipped)** | An unattended, read-only `otto-review` bin reviews an exact PR revision and publishes an idempotent report/comment/formal review. | Large  | High       |

P27 leads because it is the foundation: attested check results are the input
P28's signals consume, the strongest evidence P24's matrix can cite, and the
cheapest way to make every later phase honest. P29 runs alongside it — the
findings are independent wiring work with immediate savings. P28 and P30
promote those foundations into live loop behavior. P31 is last not because it
matters least but because it is the largest and benefits from P27 (attested
verify commands in plan rubrics) and P24 (matrix rows to trace requirements
into).

**P32 is not part of this P27→P31 sequence at all.** It is an URGENT initiative
that surfaced independently (unattended PR review was needed now) and was
built in PARALLEL alongside this Phase 6 backlog — it does not renumber,
reorder, or supersede P27–P31, none of which have shipped. P32's own scope is
orthogonal to this phase's "attested outcomes, bounded context" theme: optional
issue/file/prompt review input (invocation-only, no env/config equivalent),
a composite `(repository, pullRequest, headSha, inputFingerprint)` identity so
a changed input or a force-push is always a fresh, exactly-once review, and an
exact, uncompressed input/diff evidence trail (`--context-compressor headroom`
compresses only the PR body, never the review-input artifact). **P27's
attested-check results can enrich a future P32 review** (e.g. citing a real
test-run outcome in a finding) once P27 ships, **but P32 does not block on
P27** — it shipped against today's (unattested) evidence model and can adopt
P27's signal later as a pure addition.

Numbering continues from Phase 5. Prior roadmap epics:
[Phase 1 #38](https://github.com/phamvuhoang/otto/issues/38),
[Phase 2 #68](https://github.com/phamvuhoang/otto/issues/68),
[Phase 3 #83](https://github.com/phamvuhoang/otto/issues/83),
[Phase 4 #109](https://github.com/phamvuhoang/otto/issues/109), and
[Phase 5 #183](https://github.com/phamvuhoang/otto/issues/183).

---

## P27: Harness-Attested Feedback Loops

**Outcome:** every claim that "the suites pass" in a review, verify, or
apply-review path is backed by a command the harness itself executed, with the
exit code, duration, and output signature recorded in the evidence bundle.

**Hypothesis:** if the harness runs the repo's configured check commands after
each fix commit and records the results as first-class evidence, then false
"tests green" reports drop to zero and downstream systems (adaptive iteration
control, verification matrix, eval) gain a truth signal they currently lack —
because today every such claim is agent prose the harness never verifies.

**Scope:**

- A `checks` contract in `.otto/config.json` (e.g.
  `{ "checks": ["pnpm -r typecheck", "pnpm -r test"] }`), policy-scoped like
  every other configured command; absent config ⇒ no behavior change.
- A pure `checks.ts` module (classification, signature extraction, record
  shaping) plus an impure runner reusing the `bench.ts` `runFixtureChecks`
  pattern (exit-0 = pass) at the loop boundary.
- Attestation points, all opt-in via the presence of the `checks` config:
  - after the single reviewer's or panel synth's `fix(review):` commit;
  - after each `apply-review` iteration commit;
  - in `--verify` mode, re-execute `method:"test"` matrix rows instead of
    only checking that the cited artifact path exists.
- A `ChecksRecord` on stage records and the run manifest: command, exit code,
  duration, truncated output tail, and a stable failure signature.
- Disagreement surfacing: when the agent claimed pass and the harness observed
  fail, the report says so explicitly and the run's verdict cannot be
  "working" — the quality report and `succeeded` eval signal incorporate
  attested results, not exit-reason alone.
- `otto-inspect` and the run report render attested checks next to the claims
  they attest.

**Success metrics:**

- 100% of fix commits in configured repos carry an attested `ChecksRecord`.
- Zero runs report "tests pass" while an attested check failed.
- Eval `succeeded` disagrees with exit-reason on fixtures where work was
  committed with failing checks (a new eval fixture proves this).
- Runs without a `checks` config behave byte-for-byte as today.

**Dependencies:** P0 trajectory/evidence, P4 safety policy (command scoping),
P15 reports, P24 verification matrix, `bench.ts` check-runner pattern.

---

## P29: Prompt Diet — Bounded Injection And Cache-Shaped Templates

**Outcome:** per-iteration prompt cost drops materially with no quality loss,
by wiring the bounding levers that already exist, deleting duplicated
payloads, and shaping templates so static content forms a cacheable prefix.

**Hypothesis:** if the harness injects a bounded, relevance-selected memory
projection instead of the whole `LEARNINGS.md`, spills large payloads once
instead of twice, and orders templates static-first, then prompt tokens per
stage drop 20–40% on mature repos at equal benchmark success — because the
audit showed the dominant per-iteration cost is repeated static and unbounded
content, not task-specific context.

**Scope:**

- Replace the wholesale `` !?`cat ./.otto/LEARNINGS.md` `` injection in all
  six entry templates with a harness-rendered bounded block using the existing
  `boundLearnings`/`selectRelevantMemory`/`formatBoundedLearnings` substrate
  (`memory.ts`), honoring its 6000-char default budget.
- Deduplicate the ghafk issue payload: keep the spilled full dump (already
  compressor-eligible), reduce the inline `<issues-summary>` block to
  number/title/labels.
- Spill the review diff once per iteration and share the spill path across
  panel lenses instead of re-running `git show HEAD` per lens.
- Reorder entry templates static-first (playbook includes before dynamic
  blocks) so the static ~400-line chain forms a stable prefix; measure with
  the `cache_read_input_tokens` the runner already parses.
- Feed the compressor's dead `memory-projection` category: once learnings flow
  through a spill, `--context-compressor headroom` can act on them under the
  existing anchor-survival floor.
- Make `--token-mode reduce` honest: hang the bounded-learnings and
  commit-compaction levers off it, or rename what it reports.

**Success metrics:**

- Prompt tokens per stage drop ≥20% on a mature-repo fixture (large
  `LEARNINGS.md`, 50-issue backlog) at equal benchmark success.
- Panel-mode lens prompts show nonzero cache reads on consecutive lenses.
- Fact-survival eval shows no regression when learnings flow through the
  bounded/compressed path (reuses the P22 gate).
- Runs on repos with a small `LEARNINGS.md` are visually unchanged.

**Dependencies:** P7 context telemetry, P20/P22 compressor and survival gates,
`memory.ts` bounded-projection substrate, panel orchestration.

---

## P28: Regression Signals And Review Integrity

**Outcome:** adaptive iteration control reacts to attested check failures and
recurring findings; the review pipeline's own bookkeeping stops disagreeing
with itself.

**Hypothesis:** if the loop feeds real signals — attested check results and
finding signatures — into the `deriveProgress`/`decide` machinery that already
models them, then repeated-failure loops and re-fixed defects are detected
within one iteration instead of never, because the control plane finally
observes what the run is actually doing.

**Scope:**

- Wire the inert fields: populate `failingChecks`/`failureSignature` from
  P27's `ChecksRecord`s and `findingSignatures` from panel findings, replacing
  the hardcoded `null`/empty at the `deriveProgress` call sites in `loop.ts`.
- Cross-iteration finding memory: persist per-run finding signatures so a
  finding re-raised in a later iteration is flagged (and counted) instead of
  silently re-entering the fix cycle.
- Reconcile `reviewSeverity`: report totals count only verifier-CONFIRMED
  findings; REJECTED findings appear separately, not in headline counts.
- Post-synth confirmation: a cheap-tier pass that diffs the synth commit
  against the CONFIRMED findings list and flags unaddressed items — closing
  the "trust the verifier, trust the synth" chain with one bounded check.
- Panel read-only hardening: on a dirty worktree, either stash-and-restore
  around lenses or refuse panel mode with a clear message — no more
  warn-and-continue hole.
- Populate the declared-but-inert `toolsUsed`/`safetyEvents` stage-record
  fields at their natural production points.

**Success metrics:**

- A fixture with a recurring injected defect is escalated (pause or tier
  bump) within one iteration of its second appearance.
- Report severity totals match verifier verdicts on every panel run.
- Post-synth confirmation catches a synthetic "synth skipped a CONFIRMED
  finding" fixture.
- Panel mode on a dirty worktree either restores it exactly or refuses to
  run; no third outcome.

**Dependencies:** P27 attested checks, P14 review panel, `progress.ts`
machinery, review-severity and report-finalize pipelines.

---

## P30: Context Budget Enforcement And State Digest

**Outcome:** when a stage's assembled context exceeds its budget, the harness
degrades it through governed levers instead of shipping it anyway; stale
re-derived context retires into a compact harness-written digest.

**Hypothesis:** if `assessContextBudget`'s recommendation becomes an
enforcement ladder (bound tighter → compress → compact) under an explicit
opt-in, and prior-iteration state is carried by a digest the harness writes
from the manifest instead of re-derived blobs, then long-run token slope
flattens — because P22's lifecycle work already proved most late-run context
is stale evidence, and the survival evals now exist to gate the cut.

**Scope:**

- An `enforce` tier for `--token-mode` (or `--context-budget enforce`): when
  `assessContextBudget` reports over-budget, apply levers in order —
  tighter `boundLearnings` budget, spill compression, `compactCommits` — and
  record each application as a context event; never silently truncate task
  inputs.
- The P22 retirement slice: a per-run state digest (tasks done, current
  focus, open findings, last attested check state) written by the harness
  from the manifest and injected in place of unbounded re-derivation;
  original evidence stays retrievable via run-bundle handles.
- A char bound on the `resumeNote` chain, matching the skills block's
  existing budget pattern.
- Context reports distinguish enforced from advisory outcomes: what was
  bounded, compressed, compacted, or retired, and what each saved.
- Off by default. Measure-only remains the default mode; enforcement is a
  flag/config opt-in, gated on the P22 survival evals passing for every
  category it touches.

**Success metrics:**

- Last-third tokens per iteration stay within the P22 target band of the
  first third on a long-run fixture, with enforcement on.
- No benchmark regression with enforcement on (survival evals green).
- Every enforcement action is visible in the context report with its
  measured saving.
- Default runs (no opt-in) are byte-for-byte unchanged.

**Dependencies:** P29 wired levers, P22 lifecycle + survival evals, P7
telemetry, context-budget/context-report substrates.

---

## P31: Plan Soundness And A Working Human Loop

**Outcome:** the plan gate judges substance as well as shape, the human
checkpoint's edit path works, sharpening can ask a real question when a human
is present, and every loop mode can opt into plan gating.

**Hypothesis:** if a cheap-tier semantic judge scores what the lexical rubric
cannot (alternatives weighed, risks named, tests genuinely mapped to success
criteria), and the checkpoint lets a human edit-and-resubmit instead of
collapsing edit into reject, then approved plans need fewer implementation
iterations and less review churn — because the gate stops being satisfiable
by keyword placement and the human stops being a rubber stamp on a 2-minute
timer.

**Scope:**

- **Semantic plan judge:** a cheap/mid-tier judge stage scoring
  alternatives-weighed, risk/rollback substance, and requirement→task→test
  traceability; runs only on plans that already pass the lexical rubric
  (which stays as the fast pre-filter). Judge scores join the gate decision
  and the checkpoint prompt.
- **Working edit path:** on "edit", pause for on-disk edits to
  `spec.md`/`plan.md`, re-score (rubric + judge), and continue — a real
  edit-resubmit loop replacing the current edit≡reject collapse.
- **Second re-plan at escalated tier:** when the first re-plan also falls
  short, one more attempt at a stronger tier before pausing.
- **Interactive sharpening questions:** when `--sharpen-input` finds unmet
  dimensions _and_ the session is interactive, ask up to N plan-changing
  questions before planning; AFK keeps record-assumptions-and-proceed. Never
  an interview tax: questions must map to unmet sharpness dimensions.
- **Traceability:** stable plan-task IDs referenced by P24 matrix rows, so
  spec → task → verification artifact is one checkable chain; fixes the
  scope-drift misfire when a plan names zero paths (no paths ⇒ no drift
  verdict, recorded as a gap instead).
- **Gate everywhere:** allow `--plan`-style gating on ghafk/linear intake
  (score the issue-derived plan before implementation), preserving each
  bin's existing default behavior when the flag is absent.

**Success metrics:**

- Keyword-stuffed fixture plans that pass the lexical rubric are rejected by
  the judge; genuinely deep plans pass both.
- Edited-and-resubmitted plans complete the loop without operator surgery.
- Implementation iterations and review-fix commits drop on vague-input
  fixtures versus rubric-only gating.
- Matrix rows cite plan-task IDs on gated runs; scope-drift false positives
  on zero-path plans drop to zero.

**Dependencies:** P13 plan gate, P23 sharpening, P24 matrix, P27 attested
checks (verify-command substance), model-tier routing.

---

## Sequencing (Now / Next / Later)

```text
NOW — attest outcomes and stop paying for repeated context
  P27  Harness-attested feedback loops
  P29  Prompt diet: bounded injection and cache-shaped templates

NEXT — promote attested signals and bounded context into loop behavior
  P28  Regression signals and review integrity
  P30  Context budget enforcement and state digest

LATER — gate plans on substance with a working human loop
  P31  Plan soundness and a working human loop
```

**Why this order.** Attestation (P27) is the cheapest honesty win and the
prerequisite for real iteration control; the prompt diet (P29) is independent
wiring work with immediate savings, so both start now. P28 consumes P27's
signals; P30 consumes P29's levers and P22's survival gates — both are
promotions of proven foundations, so they follow. P31 is the largest and
touches the human workflow; it lands last so the judge can cite attested
verify commands and the traceability chain can anchor into a matrix that
P27 has already hardened.

This is a Now/Next/Later roadmap, not a date commitment. Promotion depends on
eval evidence.

## Dependency Map

```text
P27 attested checks
  -> P28 progress signals (failingChecks/failureSignature)
  -> P24 matrix rows re-executed
  -> P31 judge cites attested verify commands
  -> eval `succeeded` gains a truth signal

P29 bounded injection + cache shape
  -> P30 enforcement ladder (levers must exist before enforcement)
  -> cheaper baseline for P26 efficiency thresholds

P22 lifecycle + survival evals (shipped)
  -> gate P29 compressed-learnings path
  -> gate P30 retirement and enforcement

P24 verification matrix (shipped)
  -> P31 traceability anchor
```

## Risks And Explicit Non-Goals

- **Do not let attestation become a second implementation of CI.** P27 runs
  the repo's configured checks at defined boundaries; it does not invent
  check discovery, matrix builds, or flaky-test management.
- **Do not enforce budgets by silent truncation.** P30 degrades through
  governed, recorded levers; task inputs and policy/safety content are never
  cut. Measure-only stays the default.
- **Do not regress the fresh-process-per-stage model.** P29 shapes prompts
  for caching; it does not introduce session reuse or cross-stage
  conversational state.
- **Do not turn the semantic judge into a second implementer.** P31's judge
  scores the plan document; it does not rewrite plans or browse the repo
  beyond the plan artifacts and file map.
- **Do not make sharpening an interview tax.** Interactive questions are
  bounded, map to unmet sharpness dimensions, and never block AFK.
- **Do not re-propose what Phase 5 deferred.** Live graph injection stays
  gated on the P26 spike; content/AST conflict analysis stays deferred to
  P26; auto conflict _resolution_ in fan-out stays out of scope.
- **Not in Phase 6:** a marketplace, hosted UI, public-journal expansion,
  session-resume runners, or any default-on behavior change — every
  initiative keeps Otto's opt-in-and-inert convention.

## First Phase 6 Implementation Slice

Recommended first slice: P27 attested checks with no default behavior change.

1. Define the `checks` config contract and a pure `checks.ts` (command
   classification, failure-signature extraction, `ChecksRecord` shaping) with
   unit tests; absent config ⇒ inert.
2. Add the impure runner at the loop boundary, reusing the `bench.ts`
   exit-0 pattern, policy-scoped, with output tails truncated into the
   record.
3. Attest exactly one boundary first — after the reviewer/synth
   `fix(review):` commit — and render the result in the run report next to
   the agent's claim.
4. Add the disagreement fixture: an agent that claims pass while a check
   fails; assert the report surfaces the conflict and `succeeded` reflects
   the attested result.
5. Extend to `apply-review` and `--verify` matrix re-execution in the next
   slice; wire P28's signals only after two boundaries are attested and
   stable.
