# Otto Harness Roadmap — Phase 2: Efficient, Legible, Generative

Last updated: 2026-06-20

Phase 1 ([`HARNESS_ENHANCEMENT_ROADMAP.md`](./HARNESS_ENHANCEMENT_ROADMAP.md),
P0–P6, now shipped) turned Otto into a **governed, measurable, adaptive**
harness: every run is a typed trajectory, changes are evaluable, compute routes
by risk, memory and skills have lifecycles, and unattended authority is
policy-bounded. It works.

Phase 2 confronts what "it works" still costs and hides. From real long runs,
three gaps now dominate:

- **It is expensive, and gets more so the longer it runs.** Token consumption
  climbs fast across iterations even with `--token-mode reduce` — the context
  window, not the work, is what grows.
- **It is opaque.** Console output is a wall of low-signal text; the PR a run
  produces is a diff a non-engineer cannot verify. You cannot easily see what
  Otto is doing *now*, or trust what it did when it is *done*.
- **It is silent and thin at the edges.** The plan it works from is shallow
  compared to a world-class spec, and everything it learns stays locked inside
  the repo.

**Thesis for Phase 2:** move Otto from *it works* to **efficient** (a long run's
cost stays bounded), **legible** (a human — even a non-engineer — can watch it
live and verify it when done), and **generative** (better specs in, and it
shares what it learns with the world). Each initiative below is framed as a
testable hypothesis with success metrics, not a feature.

## Research and best-practice inputs

- **Context engineering over context stuffing.** The dominant cost and
  quality lever in long agent runs is *what is in the window each turn*, not the
  loop count. Anthropic's context-engineering guidance and the broad "context
  rot" finding (quality degrades as the window fills with stale tokens) both
  argue for treating context as a managed budget: compact, retrieve, isolate,
  and cache rather than accumulate. This grounds **P7**.
- **Plan quality dominates outcome quality.** In agentic coding, most rework
  traces to under-specified work. A rich spec + task-decomposed, test-first plan
  (see [`docs/superpowers/specs`](./superpowers/specs) and
  [`docs/superpowers/plans`](./superpowers/plans) for the target shape) is
  cheaper than re-doing code. This grounds **P8**.
- **Trust needs legibility, not just evidence.** Phase 1 produces an evidence
  bundle; Phase 2 must make it *understandable* — live (a glanceable run view)
  and at rest (a report a layperson can act on). This grounds **P9** and **P10**.
- **Harness engineering is multi-model and multi-agent.** The harness-engineering
  framing from Phase 1's inputs treats model-tier routing and sub-agent
  orchestration as first-class cost/latency levers, not afterthoughts. This
  grounds **P11**.
- **Build-in-public compounds for an autonomous agent.** An agent that narrates
  its own craft is novel and shareable — *if* it never leaks product or sensitive
  detail. Otto already has the safety/taint substrate to be the secrecy gate.
  This grounds **P12**.

## Target users (unchanged from Phase 1, extended)

- Solo maintainers running AFK who now also care about **cost per task** and
  **trusting output at a glance**.
- **Non-engineer stakeholders** (PMs, founders, ops) who need to accept or reject
  unattended work without reading code — a new first-class audience in Phase 2.
- Tool builders extending Otto with models, sub-agents, and publish targets.
- The **OSS / agent-harness community**, as an audience for Otto's public journal.

## Business and product outcomes

| Outcome                          | Why it matters                                                                  | Candidate metric                                                          |
| -------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Bounded cost on long runs        | AFK is only viable if a 30-iteration run does not cost 10× a 3-iteration one.   | tokens/iteration slope across a run; cost per completed task; cache-hit % |
| Lower rework                     | A better plan up front is cheaper than re-doing code.                           | review-fix commits per task; % plans accepted without human edits        |
| Non-engineer merge confidence    | Widen who can operate Otto beyond people who read diffs.                        | non-engineer "could you verify this?" success; review time per run       |
| Watchable, trustworthy execution | Users catch stuck/looping runs sooner and trust unattended work.               | time-to-notice a wedged run; "I could tell what was happening" rating     |
| Cost/latency via orchestration   | Not every stage needs the top model; independent work needn't share a context. | cost per task at equal success; wall-clock on parallelizable plans        |
| Reach and community              | An autonomous agent sharing knowledge builds an audience around the project.    | posts/week within the secrecy bar; **leak incidents (hard gate: 0)**      |

## Current position (entering Phase 2)

Strong, governed foundation from Phase 1 — and a clear set of *experience and
efficiency* gaps:

- Token accounting exists (`--token-mode measure`) and prompt reduction exists
  (`reduce`), but there is **no per-stage context budget, no prompt-prefix
  caching, and no compaction of the growing transcript / learnings injection** —
  so cost grows with run length.
- The brainstorm → spec → plan workflow exists, but the **persisted plan is thin**
  relative to a world-class spec; there is no plan-quality gate.
- The evidence bundle and `otto-inspect` exist, but the **report is engineer-only**
  and the **console is low-signal**; there is no live run view.
- The agent-runtime abstraction supports Claude and Codex, but **model selection
  is per-run, not per-stage**, and there is **no sub-agent fan-out**.
- The safety/taint substrate exists but is **only used defensively** — never as an
  outbound secrecy filter for anything Otto might publish.

## Prioritized initiatives

| Priority | Initiative                          | Outcome                                                                       | Size   | Confidence |
| -------- | ----------------------------------- | ----------------------------------------------------------------------------- | ------ | ---------- |
| P7       | Context & token efficiency          | Hold a long run's per-iteration token cost roughly flat.                       | Large  | High       |
| P8       | Spec & plan authoring               | Turn a thin idea into a world-class spec + test-first plan before coding.      | Medium | High       |
| P9       | Human-legible run reports           | Make a run's output verifiable by a non-engineer.                              | Medium | High       |
| P10      | Live execution visualization        | Show, glanceably, what Otto is doing now and what it did when done.            | Medium | Medium     |
| P11      | Model & sub-agent orchestration     | Route stages to the cheapest sufficient model; fan out independent work.       | Large  | Medium     |
| P12      | Otto's public journal (SNS)         | Share non-sensitive learnings to social media as an autonomous agent journal.  | Medium | Medium     |

Priorities map one-to-one to the gaps that surfaced in real use: **P7** cost,
**P8** input quality, **P9** output legibility, **P10** live visualization,
**P11** further harness depth, **P12** community reach.

---

## P7: Context & Token Efficiency

**Outcome:** A long Otto run holds its per-iteration token cost roughly flat
instead of growing with run length, cutting cost-per-task with no quality loss.

**Hypothesis:** If Otto treats the context window as a managed budget — caching
the stable prefix, retrieving relevant memory instead of injecting all of
`LEARNINGS.md`, compacting prior-iteration context rather than re-feeding it, and
not re-reading unchanged files — then per-iteration tokens stay bounded and total
run cost drops materially, **because today's growth is accumulated context, not
necessary work**.

**Scope:**

- **Context telemetry first** — a per-stage breakdown of what filled the window
  (playbook, learnings, diffs, file reads, prior-iteration transcript), surfaced
  in the evidence bundle and an `otto-afk --context-report`. Measure before
  optimizing.
- **Prompt-prefix caching** — mark the static playbook + learnings block as a
  cached prefix (provider prompt caching) so the stable head is not re-billed
  each turn.
- **Bounded learnings injection** — retrieve the memory records relevant to the
  current task scope (reuse governed memory, P3) instead of injecting the entire
  `LEARNINGS.md`; cap the block and report what was dropped.
- **Inter-iteration compaction** — summarize prior iterations into a bounded
  state rather than carrying the full transcript forward.
- **Read deduplication** — track files already read this run; avoid re-spilling
  unchanged content.
- **Per-stage context budget** — a soft ceiling with a warning + compaction
  trigger, model-aware.

**Success metrics:**

- tokens/iteration slope across a 30-iteration fixture is near-flat (define a
  target band, e.g. last-third average within +X% of first-third).
- cost per completed task ↓ on the eval suite at equal success rate.
- cache-hit rate on the static prefix reported and non-trivial.
- **no regression** on P1 benchmark success/quality signals.

**Dependencies:** P0 (token accounting + bundle), P1 (eval proves no regression),
P3 (memory retrieval). Highest priority — it gates the viability of every longer
run and amplifies P8/P11.

---

## P8: Spec & Plan Authoring

**Outcome:** From a thin prompt, Otto produces a rich, structured **spec** (problem,
decisions, scope-guard, component/file map, testing) and a **task-decomposed plan**
(per-task TDD + verification steps) — the quality of the `docs/superpowers`
examples — persisted for human review before it writes code.

**Hypothesis:** If Otto plans world-class before implementing, then rework drops
and output quality rises, **because most failures trace to under-specified work,
and a good plan is far cheaper than re-doing code** (and fewer flailing iterations
also cut tokens, reinforcing P7).

**Scope:**

- A dedicated **`plan` stage** that emits a spec + plan in the proven shape
  (problem → decisions → scope guard → file map → task-by-task steps with
  failing-test-first and explicit verify commands), persisted under
  `.otto/tasks/<task-key>/`.
- A **plan-quality rubric** scored as an eval signal (has scope guard? per-task
  verification? file map? testable success criteria?).
- An **optional human checkpoint**: render the plan, let the operator approve or
  edit before implementation begins (ties to the approval-gate candidate below).
- Reuse the existing brainstorm → spec → plan workflow; upgrade the *template*,
  not the philosophy. Keep "record assumptions and proceed" for autonomous runs.

**Success metrics:**

- review-fix commits per task ↓ (less rework).
- % of generated plans accepted without human edits ↑.
- implementation-stage token cost ↓ (a good plan → fewer corrective iterations).
- plan-completeness rubric score ↑ across fixtures.

**Dependencies:** P1 (eval/rubric), P7 (the richer plan stage must itself be
token-efficient), the existing brainstorm workflow.

---

## P9: Human-Legible Run Reports

**Outcome:** The report a run produces is verifiable by a **non-engineer** — a
plain-language "what changed, why, and how to check it works", not a diff dump.

**Hypothesis:** If every run produces an outcome-framed, plain-language report
with concrete, non-technical verification steps (and visual evidence where
relevant), then non-engineer stakeholders can accept or reject work without
reading code, **widening who can operate and trust Otto**.

**Scope:**

- A report that leads with prose: **What changed · Why · How to verify
  (step-by-step, non-technical) · What to watch / risks**, with the diff linked
  below, not first.
- **Before/after framing** and embedded evidence where it applies (test output,
  a screenshot of a changed surface, a sample command + expected result).
- Plain-language **uncertainty**: what Otto was unsure about, in human terms.
- Rebuild the quality-report contract for a layperson reader; keep the
  engineer-facing detail one click down.
- `otto-explain <run-id>` (or `otto-inspect --plain`) to re-render any past run
  for a non-engineer.

**Success metrics:**

- non-engineer "could you verify this change?" success rate in user testing.
- PR review time ↓; % reports rated "I understood it without reading code".
- run report adopted as the default PR handoff artifact (Phase-1 P6 metric, now
  for a broader audience).

**Dependencies:** P0 (evidence bundle), the quality-report contract.

---

## P10: Live Execution Visualization

**Outcome:** A meaningful real-time view of what Otto is doing — current stage,
plan progress, cost burn, recent meaningful actions — plus a crisp "done" view,
replacing the wall of low-signal console text.

**Hypothesis:** If Otto streams a structured, glanceable live view (a progress
tree + plan checklist + running spend + current decision) instead of raw token
scrollback, then users trust unattended runs more and catch problems sooner,
**because the current console hides progress and cost behind noise**.

**Scope:**

- **Redesigned console UI**: a progress tree (iteration → stage → action), a live
  plan checklist that ticks as tasks complete, running cost/tokens/elapsed, the
  current route/decision, and a tail of *meaningful* actions (edits, commits,
  test results) — not raw model tokens. Quiet by default; `--verbose` for the
  firehose.
- A **live run view** that mirrors the evidence bundle as it is written — a
  local, auto-refreshing page (or a live-updating markdown) the operator can open
  to watch a detached run; `otto-watch` / `otto-tail <run-id>` to attach.
- A **"done" summary card**: outcome, cost, iterations, what landed, what is
  deferred, next action.
- Honor `NO_COLOR` / non-TTY; degrade to clean structured lines for logs/CI.

**Success metrics:**

- time-to-notice a stuck/looping run ↓.
- user-rated "I could tell what was happening at a glance" ↑.
- reduced need to open `.otto-tmp/logs` during a run.

**Dependencies:** P0 (the bundle is the live data source), P6 (operator surfaces),
and pairs naturally with P9 (the "done" card is the legible report's headline).

---

## P11: Model & Sub-Agent Orchestration

**Outcome:** Otto runs each stage on the cheapest model that meets its bar and
fans out independent work to isolated sub-agents — cutting cost and wall-clock
without losing quality.

**Hypothesis:** If Otto routes stages to model tiers by difficulty (cheap model
for mechanical/codegen, strong model for design/review) and parallelizes
independent plan tasks in isolated sub-contexts, then cost-per-task and latency
drop while quality holds, **because not every stage needs the top model, and
independent tasks need not share one growing context** (reinforcing P7).

**Scope:**

- **Per-stage model-tier policy** — extend the adaptive router (P2) to route the
  *model*, not just review depth; escalate to a stronger tier on repeated failure.
- **Sub-agent fan-out** — run independent plan tasks (from P8) as isolated
  sub-agents with their own bounded context, then a verifier/synthesizer that
  merges results into one coherent change set.
- **Cost/quality A/B** via the eval suite (P1) to set the routing policy
  empirically, not by intuition.
- Reuse the agent-runtime abstraction; sub-agents inherit the sandbox + safety
  policy.

**Success metrics:**

- cost per task ↓ at equal success rate.
- wall-clock ↓ on parallelizable plans.
- escalation rate stays sane (cheap-first does not silently degrade quality).

**Dependencies:** P1 (eval), P2 (adaptive router), P7 (context isolation), P8
(task decomposition feeds fan-out), agent-runtime abstraction.

---

## P12: Otto's Public Journal (Build-in-Public on SNS)

**Outcome:** During a run, Otto shares interesting, **non-sensitive** learnings and
reflections to social media (Threads first) — a journal of an autonomous coding
agent sharing its craft with the world.

**Hypothesis:** If Otto publishes a curated, secrecy-filtered stream of its own
learnings, then it builds an audience and demonstrates the harness's transparency,
**because an agent narrating how it works is novel and shareable — provided it
never leaks product, code, or sensitive detail**.

**Scope:**

- A **journal stream distinct from the work log**: general craft learnings,
  gotchas, dead-ends, and reflections — explicitly **not** features, product
  decisions, customer data, repo/file names, or business specifics.
- A **strict outbound secrecy filter** built on the P4 safety/taint substrate:
  redact/deny anything matching secret patterns, repo identifiers, code, or
  policy-flagged content. **Zero-leak is the hard gate** — a post that cannot be
  proven safe is not sent.
- A **Threads publishing integration** (API + credentials), **opt-in per repo**,
  with cadence/rate control and de-duplication.
- Two modes: **draft → human approve → post** (default) and **fully autonomous**
  (explicit opt-in only); a persona ("a coding agent's field notes").
- Journal entries are sourced from governed memory (P3) and run reflections, then
  generalized so no entry is traceable to a specific repo or change.

**Success metrics:**

- posts published per week within the secrecy bar.
- **leak incidents: 0** (hard gate; any leak halts the integration).
- audience growth / engagement; opt-in adoption.

**Dependencies:** P4 (safety/taint as the secrecy filter — the critical
dependency), P3 (learnings as source), a human-approval gate. Sequenced **Later**:
highest novelty, but it must not ship before its secrecy gate is airtight.

---

## Sequencing (Now / Next / Later)

```
NOW  — efficiency + input quality (foundational; everything else compounds on them)
  P7  Context & token efficiency      (cost; gates long runs)
  P8  Spec & plan authoring           (quality in; reduces rework and tokens)

NEXT — legibility + harness depth (trust and breadth, once cost/quality hold)
  P9  Human-legible run reports       (output a non-engineer can verify)
  P10 Live execution visualization    (watch it run; pairs with P9's "done" card)
  P11 Model & sub-agent orchestration (further cost/latency; builds on P7/P8)

LATER — reach (highest novelty; gated on a proven secrecy filter)
  P12 Otto's public journal (SNS)
```

**Why this order.** P7 and P8 are upstream of everything: efficiency makes longer
runs affordable, and a better plan makes every later stage cheaper and more
correct — both also *reduce* token cost, reinforcing each other. Legibility (P9,
P10) is the next-highest user value but assumes the run underneath is worth
watching. P11 deepens the harness once P7's context isolation and P8's task
decomposition exist to build on. P12 is deliberately last: its upside is real,
but shipping it before the P4-based secrecy filter is airtight risks the one
failure (a leak) that is unrecoverable.

This is a **Now/Next/Later** plan, not a date commitment — it evolves as the eval
suite (P1) tells us which bets actually moved the metrics.

## Additional harness candidates (unprioritized backlog)

Strong best-practice ideas held below the line until a metric or user pulls them up:

- **Interactive approval gates** — wire the policy's `approvalRequiredActions`
  to a real human checkpoint (approve/deny a risky action or a plan before it
  proceeds); the natural home for P8's plan-approval and P12's post-approval.
- **MCP / tool authority** — typed, policy-governed tool access (beyond shell),
  so the harness can grant capabilities with the same lifecycle as memory/skills.
- **Self-healing test loop** — run the suite, feed failures back as structured
  signal, and gate "done" on green (deepens the existing reviewer feedback).
- **Multi-repo / monorepo awareness** — scope context, memory, and skills per
  package within one workspace.
- **Auto-skill promotion** — the opt-in loop wiring deferred from Phase-1 P5:
  retrieve + apply a validated skill in the live loop (`--use-skills`).

## Risks and explicit non-goals

- **P7 measurement risk** — "token efficiency" must be proven against the eval
  suite, not asserted; ship telemetry (the `--context-report`) before any
  optimization, and gate each optimization on no quality regression.
- **P10 scope creep** — a live web dashboard can balloon. Start with the console
  redesign + a local auto-refreshing view; defer any hosted/multi-user UI.
- **P12 is the highest-risk initiative** — a single leak is reputationally
  unrecoverable. It is gated on P4 and a human-approval default; **not** building:
  posting product/feature/customer detail, auto-following/auto-replying, or any
  cross-posting beyond the one opt-in target.
- **Not building this phase:** a hosted control plane, cross-machine run sync, or
  a non-CLI primary workflow. Otto stays CLI-first and local; Phase 2 makes that
  surface efficient and legible, not heavier.
