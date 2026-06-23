# Otto Harness Roadmap — Phase 3: From Shape to Substance

Last updated: 2026-06-23

Phase 1 ([`HARNESS_ENHANCEMENT_ROADMAP.md`](./HARNESS_ENHANCEMENT_ROADMAP.md), P0–P6)
made Otto **governed, measurable, and adaptive**. Phase 2
([`HARNESS_ROADMAP_PHASE2.md`](./HARNESS_ROADMAP_PHASE2.md), P7–P12) made it
**efficient, legible, and generative**. Both shipped.

Phase 3 confronts a gap that runs through all of it. Otto now has rubrics,
gates, lenses, and report contracts — but on close inspection most of them check
that an artifact has the right **shape**, not whether it has the right
**substance**:

- The plan rubric checks that a scope-guard *header exists*, not whether the
  scope guard is *real*. The re-plan loop and scope-drift detection are not
  wired.
- The review panel checks correctness, security, tests, and task-fit — but
  **nothing asks "did this change make the codebase worse?"** No check for
  incidental complexity, file bloat, spaghetti conditionals, duplication, or
  missed simplifications. Every lens runs at the top tier, every iteration,
  sequentially, with no severity signal.
- The report contract mandates seven layperson sections, but the legibility
  rubric is **never called at emit time**, evidence is cited by hand, and the
  report describes *what changed* rather than *what the end user can now do*.

**Thesis for Phase 3:** move Otto from *it has the right shape* to **it judges
and enforces substance** — a plan gate that scores depth and self-heals, a
review that defends codebase health and spends compute only where it pays, and a
report written around end-user outcomes a non-engineer can act on. Each
initiative below is framed as a testable hypothesis with success metrics.

## Research and best-practice inputs

- **Plan depth, not plan presence.** Phase 2's P8 established a plan *template*
  and a presence-based rubric. The remaining rework traces to plans that have
  the right headers but thin content — a file map that omits the files actually
  touched, "test-first" tasks with no failing test named. The lever is scoring
  *depth* and closing the loop (re-plan when the score is low). This grounds
  **P13**.
- **Code review must defend codebase health.** Cursor's
  [thermo-nuclear-code-quality-review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md)
  skill encodes a strict, externally-validated bar: look for "code judo" moves
  that delete whole branches, block files over 1,000 lines, reject spaghetti
  conditionals on unrelated paths, refuse to rubber-stamp "it works"
  implementations that leave the codebase messier — and an **output hierarchy**
  that surfaces structural regressions first and suppresses low-value nits when
  major issues exist. Otto's panel has no equivalent lens. This, plus
  efficiency, grounds **P14**.
- **Reports should lead with the user's job, not the diff.** Phase 2's P9 made
  reports layperson-first in *structure*; Phase 3 makes them outcome-first in
  *substance* — "here is what you can now do" before "here is what changed" —
  with evidence collected automatically and uncertainty surfaced by severity.
  This grounds **P15**.

## Target users (unchanged from Phase 2)

- Solo maintainers running AFK who care about merge confidence and cost.
- Non-engineer stakeholders who accept or reject work without reading code.
- Tool builders extending Otto with lenses, gates, and report surfaces.

## Business and product outcomes

| Outcome                          | Why it matters                                                              | Candidate metric                                                       |
| -------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Less rework from thin plans      | A plan that is deep, not just well-shaped, prevents corrective iterations.  | re-plan rate; review-fix commits per task; plan depth-score           |
| Healthier codebase over time     | Reviews that miss structural decay let complexity compound silently.        | structural findings caught/fixed; file-size regressions blocked       |
| Cheaper, sharper reviews         | Not every lens needs the top model every iteration; nits bury signal.       | review cost per task; nit ratio in committed fixes; blocker-catch rate |
| Non-engineer can act on output   | Output framed as user outcomes widens who can accept unattended work.       | "I knew what I could now do" rating; non-engineer verify success       |
| Trustworthy, traceable fixes     | A confirmed finding should be traceable to the commit that fixed it.        | finding→commit trace coverage; evidence auto-citation rate            |

## Current position (entering Phase 3)

| Subsystem | What exists | The substance gap |
| --------- | ----------- | ----------------- |
| **Spec & plan** | `plan-rubric.ts` (8 presence criteria), `plan-gate.ts` (75% soft threshold), `plan-checkpoint.ts` (opt-in), `plan-tasks.ts` (DAG) | Rubric is presence-based; depth unmeasured. Re-plan loop and scope-drift detection not wired. Checkpoint not live. |
| **Code review** | `panel.ts` (lenses → adversarial verify → CONFIRMED-only synth), 4 lenses, `model-tier.ts` | No structural/maintainability lens. Findings are free-text, no severity. All lenses at `strong` tier, sequential, no dedup, no risk-routing, no finding→commit trace. |
| **Final output** | `quality-report.md` (7-section layperson contract), `report-rubric.ts` (7 criteria), `otto-explain` | Rubric never called at emit time. Evidence cited by hand. No severity/confidence surfacing. Reports describe changes, not end-user use cases. afk/plan modes emit none. |

## Prioritized initiatives

| Priority | Initiative                          | Outcome                                                                       | Size   | Confidence |
| -------- | ----------------------------------- | ----------------------------------------------------------------------------- | ------ | ---------- |
| P14      | Structural code-quality review      | The review defends codebase health and spends compute only where it pays.     | Large  | High       |
| P15      | Outcome-first user reports          | The report leads with what the end user can now do, verified and traceable.   | Medium | High       |
| P13      | Semantic spec & plan gate           | The plan gate scores depth and self-heals before code is written.             | Medium | Medium     |

Sequenced **P14 → P15 → P13**: P14 imports an externally-validated quality bar
and is the highest leverage on trust; P15 can then honestly surface what a
stronger review confirmed; P13 deepens the front of the loop once the back is
trustworthy. (Numbering continues Phase 2's P7–P12; the build order is by
leverage, not by number.)

---

## P14: Structural Code-Quality Review

**Outcome:** Otto's review panel gains a structural-quality lens that defends
codebase health, makes every finding severity-ranked, and spends review compute
only where the change warrants it.

**Hypothesis:** If Otto reviews each change through a structural lens grounded in
its own simplicity-first conventions — and ranks findings by severity, suppresses
nits when blockers exist, routes lenses by risk, and dedupes before verifying —
then it catches the codebase decay it misses today **at lower cost**, because the
current panel checks behavior but never asks whether the change left the codebase
messier, and pays full price for every lens regardless of risk.

**Scope:**

- A **`structural` lens** grounded in cursor's seven non-negotiable standards and
  diagnostic questions, *adapted to Otto's `.claude/CLAUDE.md`* (simplicity-first,
  surgical changes, YAGNI) so it reinforces existing repo rules.
- A **severity model** (`blocker | major | minor | nit`) on every finding.
  Lenses emit structured findings; the adversarial verifier confirms, refutes, or
  **downgrades**; synth applies in severity order and **suppresses nits when
  higher-severity findings exist** (cursor's output hierarchy).
- **Finding→commit trace** — synth annotates the `fix(review):` commit with the
  confirmed findings it addressed.
- Four **efficiency levers**: risk-routed lens selection (reuse the P2 risk
  classifier), per-lens model-tier routing (extend `model-tier.ts`), cross-lens
  dedup before verify, and parallel lenses with early-exit when no findings
  survive.

**Success metrics:**

- structural findings caught and fixed on a deliberately-bloated/spaghetti
  fixture in the eval suite.
- review cost per task ↓ (risk-routing + dedup) at equal blocker-catch rate.
- nit ratio in committed fixes ↓.
- finding→commit trace present in 100% of synth commits.
- **no regression** on P1 benchmark success/quality signals.

**Dependencies:** P2 (risk classifier), the existing panel and `model-tier.ts`,
P1 (eval proves no regression). Detailed spec:
[`docs/superpowers/specs/2026-06-23-structural-code-quality-review-design.md`](./superpowers/specs/2026-06-23-structural-code-quality-review-design.md).

---

## P15: Outcome-First User Reports

**Outcome:** The report a run produces leads with what the **end user can now
do**, cites its evidence automatically, surfaces uncertainty by severity, and
scores its own legibility before it is emitted.

**Hypothesis:** If Otto frames each report around the user's job ("you can now
cap retries so an unattended run can't loop forever") rather than the change
("added a `--max-retries` flag"), auto-collects file:line and commit evidence,
and gates emission on the legibility rubric, then non-engineers accept or reject
work faster and more confidently, **because today's report describes the change
and leaves the reader to infer the use case, cites evidence by hand, and never
checks its own legibility**.

**Scope:**

- **Use-case framing**: lead each report with end-user outcomes drawn from the
  plan/issue intent, not a change description; keep the change one click down.
- **Emit-time rubric gate**: call `report-rubric.ts` when the report is written;
  if it scores low, prompt a rewrite (close the loop the scorer was built for).
- **Automatic evidence collection**: gather file:line and commit SHAs from the
  run's stage records instead of asking the model to hand-cite them.
- **Severity/confidence surfacing**: carry P14's finding severities into the
  report's "what to watch" and "unsure about" sections so risk is explicit.
- Extend coverage so **plan/afk modes also emit a report** (today they emit
  none).

**Success metrics:**

- non-engineer "I knew what I could now do" rating ↑; verify-success rate ↑.
- emit-time rubric pass rate ↑; reports failing the rubric silently → 0.
- evidence auto-citation rate (file:line + SHA present without hand-editing) ↑.
- report adopted as the default PR handoff artifact for a non-engineer audience.

**Dependencies:** P0 (evidence bundle / stage records), P9 (report contract),
P14 (finding severities feed the report).

---

## P13: Semantic Spec & Plan Gate

**Outcome:** The plan gate scores plan **depth**, not just section presence, and
self-heals — re-planning when the score is low and flagging scope drift — before
any code is written.

**Hypothesis:** If Otto scores whether a plan's content is *deep* (file map lists
the files actually in scope, tasks name a failing test, success criteria are
testable) and re-plans when it is thin, then rework drops further, **because the
present rubric passes a well-shaped but shallow plan, and a shallow plan is the
cheapest place left to prevent corrective iterations**.

**Scope:**

- **Depth scoring** layered on the existing presence rubric: a file map with ≥N
  real paths, tasks that each name a failing test and a verify command,
  success criteria that are concretely testable.
- **Re-plan loop**: when the depth score is below threshold, feed the shortfall
  back and re-plan once before implementing (the loop `plan-gate.ts` was built
  to enable).
- **Scope-drift detection**: at commit time, compare touched files against the
  plan's file map and flag out-of-scope edits.
- **Live approval checkpoint**: wire `plan-checkpoint.ts` into interactive runs
  (approve/edit/reject); keep "record assumptions and proceed" for AFK.

**Success metrics:**

- plan depth-score ↑ across fixtures; re-plan rate converges (not stuck looping).
- review-fix commits per task ↓ (less downstream rework).
- scope-drift incidents flagged before merge.

**Dependencies:** P1 (eval/rubric), P8 (plan template and presence rubric), P2
(risk classifier for scope-drift sensitivity).

---

## Sequencing (Now / Next / Later)

```
NOW   — defend codebase health (highest trust leverage; imports a proven bar)
  P14  Structural code-quality review

NEXT  — make the verified result legible to a non-engineer
  P15  Outcome-first user reports   (surfaces what P14 confirmed)

LATER — deepen the front of the loop once the back is trustworthy
  P13  Semantic spec & plan gate
```

**Why this order.** P14 is upstream of trust: a report (P15) can only honestly
claim what a strong review confirmed, and a deep plan (P13) pays off most once
the review that judges its output is rigorous. P15 follows directly — it
surfaces P14's severities to the human. P13 is sequenced last only because its
payoff compounds with a trustworthy review, not because it is less valuable.

This is a **Now/Next/Later** plan, not a date commitment — it evolves as the eval
suite (P1) tells us which bets moved the metrics.

## Risks and explicit non-goals

- **P14 must not become a refactoring engine.** The structural lens *flags*
  decay; synth fixes only CONFIRMED findings and never refactors beyond them —
  preserving the surgical-changes rule in `.claude/CLAUDE.md`. Non-goal:
  auto-rewriting working code for style.
- **P14 efficiency must be proven, not asserted.** Risk-routing and per-lens
  tiering are gated on the eval suite showing equal blocker-catch rate at lower
  cost; a missed blocker from skipping a lens is a regression.
- **P15 use-case framing must not invent value.** The report states only
  outcomes traceable to the plan/issue intent; non-goal: marketing language or
  claims the diff does not support.
- **P13 depth scoring must stay heuristic and cheap.** It augments the
  deterministic rubric, not a model-call-per-plan gate; non-goal: a slow,
  expensive semantic judge in the hot path.
- **Not building this phase:** a hosted dashboard, cross-machine sync, or a
  non-CLI workflow. Otto stays CLI-first and local.
