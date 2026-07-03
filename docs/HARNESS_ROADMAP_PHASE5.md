# Otto Harness Roadmap — Phase 5: Make Existing Power Useful

Last updated: 2026-07-03

> **Status:** P22–P24 have landed their core slices; P25–P26 are planned.
> P22: lifecycle reporting, real Headroom compression — scoped to retrievable
> spills and guarded by a runtime anchor-survival floor (#200) — and a
> CI-runnable fact-survival eval that drives the real compress path (#202).
> P23: input sharpening on the plan path (#187), with the guidance pass itself
> under eval (#202). P24: verification matrix + gallery with existence and
> produced-this-run artifact checks and matrix↔plan reconciliation (#201);
> artifact existence is machine-checked, relevance remains reviewer judgment.
>
> **Tracking:** Phase 5 epic
> [#183](https://github.com/phamvuhoang/otto/issues/183); initiatives
> [P22 #179](https://github.com/phamvuhoang/otto/issues/179),
> [P23 #180](https://github.com/phamvuhoang/otto/issues/180),
> [P24 #181](https://github.com/phamvuhoang/otto/issues/181),
> [P25 #182](https://github.com/phamvuhoang/otto/issues/182), and
> [P26 #198](https://github.com/phamvuhoang/otto/issues/198).

Phase 1 ([`HARNESS_ENHANCEMENT_ROADMAP.md`](./HARNESS_ENHANCEMENT_ROADMAP.md),
P0–P6) made Otto governed, measurable, and adaptive. Phase 2
([`HARNESS_ROADMAP_PHASE2.md`](./HARNESS_ROADMAP_PHASE2.md), P7–P12) made it
efficient, legible, generative, and multi-agent. Phase 3
([`HARNESS_ROADMAP_PHASE3.md`](./HARNESS_ROADMAP_PHASE3.md), P13–P15) made its
plan, review, and report gates judge substance. Phase 4
([`HARNESS_ROADMAP_PHASE4.md`](./HARNESS_ROADMAP_PHASE4.md), P16–P21) made
skills, tools, compression, and extension profiles governed and inspectable.

Phase 5 does not add autonomy for its own sake. Otto already has context
telemetry, Headroom, semantic plan gates, PM and coding skills, review panels,
reports, fan-out, worktrees, evidence bundles, tool authority, and extension
profiles. The remaining problem is making those capabilities consistently
useful in real repositories:

- Context remains in the model window after the decision that needed it.
- Vague requests still create avoidable planning and implementation rework.
- Reports make claims that are not always backed by concrete artifacts.
- Agents still spend many searches and reads reconstructing codebase structure
  and change impact.
- Fan-out can multiply ambiguity, overlapping ownership, and merge churn.

**Thesis for Phase 5:** improve the usefulness-per-token of Otto's existing
harness. Keep only context that serves the current decision, sharpen inputs
before coding, prove outcomes with artifacts, retrieve code structure without
dumping the repository into the prompt, and parallelize only when ownership and
merge contracts are clear.

## Product And Research Inputs

- P22's context-lifecycle work establishes the governing question for every
  prompt block: why is this still in context, and can it be retrieved later
  instead?
- P13, P18, and the PM extension profile provide the components for a stronger
  input-sharpening pass without adding a separate planning product.
- P0, P10, and P15 provide the trajectory, live view, and report surfaces needed
  to attach concrete verification artifacts to claims.
- P11 and P14 provide fan-out, model routing, specialist review, and synthesis;
  Phase 5 should harden their coordination rather than add more agents.
- [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
  builds a persistent local code-knowledge graph and exposes architecture,
  symbol, call-path, source, and change-impact queries over MCP. Its
  [published evaluation](https://arxiv.org/abs/2603.27277) reports 10x fewer
  tokens and 2.1x fewer tool calls than file-by-file exploration, with 83%
  answer quality versus 92% for the explorer. The result supports a
  graph-assisted retrieval bet, but also requires source-read fallbacks and an
  explicit quality gate.

## Strategy Context

### Business And Product Outcomes

| Outcome                        | Why it matters                                                              | Candidate metric                                                            |
| ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Lower useful-context cost      | Long runs are viable only when stale context can leave the active window.   | input tokens/completed task; tokens/iteration slope; retired-context share  |
| Less rework from vague inputs  | Ambiguity is cheaper to resolve before code exists.                         | plan depth; implementation iterations; review-fix commits                   |
| Evidence-backed merge trust    | Operators should inspect proof rather than trust a summary.                 | artifact-backed requirement coverage; review time; verification success     |
| Cheaper codebase understanding | Structural questions should not require broad repository dumps.             | exploration tokens/tool calls; impact-analysis recall; index/query latency  |
| Reliable parallel execution    | Fan-out is useful only when coordination cost stays below its latency gain. | fan-out success; conflict/defer rate; wall-clock at equal benchmark success |

### Target Users

- Solo maintainers running Otto AFK who need lower cost and stronger merge
  confidence.
- Teams operating on large, unfamiliar, multi-package, or multi-service
  repositories.
- PMs and founders who need stronger plans and inspectable evidence without
  reading every diff.
- Engineering teams that want parallel execution but require clear ownership,
  handoffs, and merge decisions.

## Current Position

- Context telemetry and Headroom exist, and P22 now classifies context by
  lifecycle, but automatic retirement is still intentionally gated on evidence.
- The semantic plan gate and validated PM skills exist, but there is no focused
  pass that sharpens vague input before the plan is scored.
- Reports are outcome-first and evidence-aware, but screenshots, command
  transcripts, and requirement-to-proof matrices are not systematic.
- P19 can describe `kind: "mcp"` tools under repo policy, but Otto does not yet
  own a runtime-neutral MCP child bridge or a freshness contract for a persistent
  code index.
- Fan-out uses task DAGs and worktrees, but ownership confidence, handoff
  contracts, conflict prediction, and synthesis evidence need hardening.

## Prioritized Initiatives

| Priority | Initiative                                 | Outcome                                                                       | Size   | Confidence |
| -------- | ------------------------------------------ | ----------------------------------------------------------------------------- | ------ | ---------- |
| P22      | Context lifecycle and Headroom utilization | Retire stale context and compress only evidence that survives retrieval.      | Medium | High       |
| P23      | Input sharpening workflow                  | Turn thin intent into a strong spec and plan with less downstream rework.     | Medium | High       |
| P24      | Visual and artifact-backed verification    | Back report claims with concrete, inspectable proof.                          | Medium | Medium     |
| P26      | Codebase Memory structural retrieval       | Reduce exploration cost and improve impact analysis with a fresh local graph. | Large  | Medium     |
| P25      | Multi-agent coordination hardening         | Make fan-out reliable through ownership, handoffs, and merge contracts.       | Large  | Medium     |

P26 follows P22–P24 in product priority even though its number follows P25.
Context lifecycle provides its cost and retention rules, input sharpening gives
its planning queries a concrete job, and artifact-backed verification gives its
impact evidence a visible destination. P25 remains last because parallel
execution amplifies every weakness in input quality, retrieval freshness, and
merge clarity.

Numbering continues from Phase 4. Prior roadmap epics:
[Phase 1 #38](https://github.com/phamvuhoang/otto/issues/38),
[Phase 2 #68](https://github.com/phamvuhoang/otto/issues/68),
[Phase 3 #83](https://github.com/phamvuhoang/otto/issues/83), and
[Phase 4 #109](https://github.com/phamvuhoang/otto/issues/109).

---

## P22: Context Lifecycle And Headroom Utilization

**Outcome:** Otto treats context as leased working memory: keep what the current
decision needs, compress retrievable evidence, and retire context that no longer
belongs in the model window.

**Hypothesis:** If Otto records why each context block is present and expires it
when the stage no longer needs it, then input cost drops without quality loss
because much of today's expensive context is stale evidence or settled
discussion.

**Scope:**

- Lifecycle categories on context records:
  `required-now | retrievable | resolved | durable`.
- A `context-report` explanation of why content remains active and what can be
  freed.
- Selective Headroom compression only for retrievable categories whose buried
  facts survive eval.
- Retirement of prior-iteration context after bounded summarization links back
  to the original evidence.
- Per-stage skill/tool context caps and removal of excerpts that are no longer
  relevant.

**Success metrics:**

- Input tokens per completed task decrease on large-context fixtures at equal
  benchmark success.
- Last-third tokens per iteration stay within a defined band of the first third.
- Every context report distinguishes active, retrievable, resolved, and durable
  content.
- Compression and retirement introduce no benchmark regression.

**Dependencies:** P7 context telemetry, P20 Headroom, P18 skill activation, and
P0 evidence.

---

## P23: Input Sharpening Workflow

**Outcome:** Otto turns a thin request, issue, or idea into a stronger brainstorm,
spec, and plan before implementation starts.

**Hypothesis:** If an optional sharpening pass extracts intent, constraints,
unknowns, alternatives, and falsifiable success criteria before the semantic
plan gate, then implementation and review rework decrease because ambiguity is
resolved before code exists.

**Scope:**

- Add an optional sharpening pass to the existing plan path:
  - goals, constraints, unknowns, success criteria, and non-goals.
  - two or three solution options when the path is materially ambiguous.
  - only high-value human questions; AFK records assumptions and proceeds.
  - a decision log the plan gate can score.
- Use validated PM skills only in planning, issue-intake, and report stages.
- Add the user outcome, file/component hypothesis, verification strategy, and
  "what would make this plan wrong?" risks to plan artifacts.
- Feed the result into the existing semantic plan gate and task DAG.

**Success metrics:**

- Plan depth rises on vague-input fixtures.
- Review-fix commits and implementation iterations decrease.
- Human plan edits become fewer and more focused.

**Dependencies:** P13 plan gate, P16–P18 skills, plan artifacts, and issue intake.

---

## P24: Visual And Artifact-Backed Verification

**Outcome:** Otto reports are backed by concrete verification artifacts, not
only plain-language claims.

**Hypothesis:** If each feasible requirement links to a screenshot, command
trace, before/after output, or rubric delta, then humans can accept or reject a
run faster because they inspect proof instead of trusting a summary.

**Scope:**

- Add a verification matrix:
  requirement/task, method, command or visual check, artifact path, result, and
  confidence.
- UI/web work: screenshots and before/after comparisons when a local surface can
  be rendered.
- CLI/library work: concise command transcripts with expected and actual output.
- Docs/planning work: checklist and rubric deltas.
- Add a verification gallery to run reports and `otto-inspect`.
- Report an unavailable verification path as a gap; never invent proof.

**Success metrics:**

- Reports include at least one concrete artifact whenever one is feasible.
- Non-engineer verification success improves.
- Manual review time decreases on UI and CLI fixtures.
- Failed verification is surfaced as risk rather than buried in logs.

**Dependencies:** P0 evidence, P10 live view, P15 reports, and P19 tool authority
for optional screenshot/browser helpers.

---

## P26: Codebase Memory Structural Retrieval

**Outcome:** Otto can build and query a fresh, local code-knowledge graph during
planning, implementation, review, and verification, reducing exploratory
context while making architecture and blast-radius claims more complete and
traceable.

**Hypothesis:** If Otto routes structural questions through Codebase Memory
before broad grep/read exploration, then large-repository tasks use fewer input
tokens and tool calls while preserving task success because one graph query can
answer cross-file architecture, caller, and impact questions that otherwise
require many searches. Raw source reads and tests remain authoritative because
the upstream evaluation shows an efficiency/quality tradeoff rather than
unconditional parity.

**Scope:**

- Add an off-by-default adapter behind P19:
  - `.otto/tools/codebase-memory.json` with `kind: "mcp"`, stdio command,
    operation and stage allowlists, timeout, health check, and minimum write
    roots.
  - `.otto/config.json` enables the adapter only for selected `plan`,
    `implementer`, `reviewer`, and `verifier` stages.
  - a `codebase-intelligence` P21 profile generates normal, inspectable config;
    no personal MCP configuration is inherited.
- Keep installation and process authority reproducible:
  - accept an operator-provided binary or a profile-supported pinned release
    whose checksum is verified.
  - run it as an Otto-owned MCP stdio child with repo-scoped cache, no runtime
    network authority, and no upstream `install` or `update` command.
  - never modify `.claude/.mcp.json`, `.codex/config.toml`, instruction files,
    hooks, or personal agent state. Generate transient runtime config only if
    the active runtime needs the bridge.
- Start with least authority:
  - controlled write operation: `index_repository` only.
  - read operations: `index_status`, `get_graph_schema`, `get_architecture`,
    `search_graph`, `trace_path`, `detect_changes`, `search_code`, and
    `get_code_snippet`.
  - exclude `delete_project`, `manage_adr`, `ingest_traces`, the graph UI, and
    shared graph artifacts until each has a separately approved use case.
  - production is gated on suppressing or redirecting the upstream
    `.codebase-memory/graph.db.zst` and `.gitattributes` side effects so every
    write remains inside Otto's declared cache or isolated scratch space.
- Make freshness a contract:
  - index at preflight when absent or stale and refresh after implementation
    before review.
  - record workspace identity, source revision/worktree state, tool version,
    index status, and indexed-at time.
  - never silently use an unavailable, degraded, wrong-project, or stale index;
    fall back to Otto's existing search/read path and record the reason.
- Route retrieval to a concrete stage job:
  - sharpen/plan: architecture, packages, entry points, dependency paths, and
    candidate file maps.
  - implement: targeted symbol and caller discovery before opening exact source.
  - review/verify: change-impact and caller/dependency traces for blast radius,
    scope drift, and verification coverage.
  - graph output is navigation evidence, not edit authority; the agent reads
    current source before changing it, and tests remain the completion gate.
- Apply P22 lifecycle rules to graph context:
  - inject bounded query results, not graph dumps.
  - classify graph results as `retrievable` once they have served the current
    decision, retain a query/index handle, and remove the payload from later
    prompts.
- Preserve evidence in `toolsUsed[]`, stage records, context reports, and P24's
  verification matrix:
  sanitized query, index identity/freshness, result size, estimated prompt
  tokens avoided, latency, consuming stage, and fallback reason.
- Add comparative eval fixtures:
  - cross-module call-chain and change-impact tasks with a buried dependency.
  - architecture/file-map generation in a multi-package fixture.
  - an edit followed by review that proves the index refreshes before use.
  - dynamic or unsupported code where graph retrieval defers to raw search.
  - missing, incompatible, degraded, offline/update-check, and policy-denied
    server paths.
  - A/B runs with the adapter off/on, scored for task success, impact recall,
    tokens, tool calls, indexing overhead, and latency.

**Success metrics:**

- Exploration input tokens and tool calls decrease materially on large-context
  fixtures at equal or better task success and impact-analysis recall.
- Every graph-assisted stage records the exact tool version and index snapshot
  that informed it; stale or wrong-project graph use is zero.
- Index build/refresh overhead is visible and repaid by retrieval savings for
  the target repository/task class.
- A missing or unhealthy server degrades to normal Otto exploration with one
  clear warning and no broken run.
- No integration path mutates personal agent configuration or writes outside
  its declared cache/scratch scope.

**Dependencies:** P19 tool authority and runtime boundary, P22 context lifecycle,
P23 plan sharpening, P0 evidence, P1 eval, P7 telemetry, P13 plan maps, P14
structural review, P21 profiles, and P24 verification artifacts.

---

## P25: Multi-Agent Coordination Hardening

**Outcome:** Otto's multi-agent paths become reliable default tools for
parallelizable work, not only advanced options.

**Hypothesis:** If fan-out has explicit ownership, bounded context, handoff
contracts, and merge-risk prediction, then it lowers wall-clock without
increasing conflict churn because coordination failure is a larger risk than raw
agent capability.

**Scope:**

- Add file-scope confidence and overlap/conflict prediction before fan-out.
- Split only when verification remains independently executable.
- Require handoffs to state changes, tests, risks, deferred work, and
  out-of-scope files.
- Merge lowest-conflict tasks first and defer risky merges with a clear reason.
- Summarize cross-task interactions before specialist review.
- Record agent contributions and synthesis decisions in the evidence bundle.
- When P26 is enabled, bind retrieval/index identity to each worktree so one
  agent cannot silently query another worktree's stale graph.

**Success metrics:**

- Fan-out success rises on disjoint-task fixtures.
- Conflict/defer rates fall or become predictable.
- Wall-clock decreases without lowering benchmark success.
- Reports explain each agent's contribution and every deferred task.

**Dependencies:** P11 fan-out/model routing, P14 review panel, P0 evidence, P23
task decomposition, and P26 worktree-aware retrieval when enabled.

---

## Sequencing (Now / Next / Later)

```text
NOW — make existing runs cheaper and inputs sharper
  P22  Context lifecycle and Headroom utilization
  P23  Input sharpening workflow

NEXT — strengthen proof and test structural retrieval
  P24  Visual and artifact-backed verification
  P26a Codebase Memory governance/retrieval benchmark spike

LATER — promote only proven retrieval and coordination paths
  P26  Codebase Memory production adapter + codebase-intelligence profile
  P25  Multi-agent coordination hardening
```

**Why this order.** P22 reduces the cost of every later capability and provides
the accounting rules for P26 output. P23 reduces ambiguity before implementation
and gives structural retrieval specific planning questions to answer. P24 makes
proof visible. P26 gets a bounded spike in Next, but production remains Later
until quality parity, index freshness, offline behavior, and write confinement
are proven. P25 remains last because parallel execution multiplies any weakness
in input quality, retrieval isolation, and merge contracts.

This is a Now/Next/Later roadmap, not a date commitment. Promotion depends on
eval evidence, not the upstream tool's headline metrics.

## Dependency Map

```text
P22 context lifecycle
  -> governs P26 graph-result retention

P23 input sharpening
  -> stronger plans and task decomposition
  -> P25 coordination quality
  -> gives P26 planning queries a concrete job

P19 tool authority + P1 eval + P0 evidence
  -> P26 governed MCP spike
  -> P26 production adapter

P24 artifact-backed verification
  -> surfaces P26 impact evidence

P26 worktree-aware retrieval
  -> optional input to P25 fan-out/review
```

## Risks And Explicit Non-Goals

- **Do not compress or retire context without evidence.** P22 changes behavior
  only after fact-survival and benchmark gates pass.
- **Do not turn sharpening into an interview tax.** P23 asks only questions that
  can materially change the plan; AFK records assumptions and proceeds.
- **Do not invent verification.** P24 reports missing render/runtime capability
  as a gap.
- **Do not make graph retrieval the source of truth.** Static graphs can be stale
  or incomplete for dynamic dispatch and generated code. Current source reads
  and tests remain authoritative.
- **Do not run upstream auto-install inside Otto.** Codebase Memory's installer
  can edit agent config, instructions, skills, and hooks. Otto uses only a pinned
  binary through repo-local P19 config and transient runtime state.
- **Do not allow hidden index writes.** Current explicit indexing can write
  `.codebase-memory/graph.db.zst` and `.gitattributes`; production waits for
  suppression, redirection, or scratch isolation.
- **Do not enable external tool authority by default.** P26 stays opt-in,
  repo-governed, policy-scoped, and observable.
- **Do not parallelize unclear work.** P25 defers tasks whose ownership or
  independent verification is uncertain.
- **Not in Phase 5:** a new marketplace, hosted UI, public-journal expansion,
  TUI automation for external agent CLIs, or a production Freebuff/Codebuff
  runtime without a stable headless contract.

## First Phase 5 Implementation Slice

P22 context-lifecycle reporting shipped first in
[PR #178](https://github.com/phamvuhoang/otto/pull/178) with no behavior change:
lifecycle categories, context-report totals, a dry-run freeable-context
recommendation, and a large-context fixture. Automatic retirement/compression
remains gated on trustworthy reports and fact-survival eval. The slice also
surfaced harness-behavior follow-up
[#177](https://github.com/phamvuhoang/otto/issues/177).

## First P26 Implementation Slice

Recommended slice: prove retrieval value and MCP governance without changing
default stage behavior.

1. Extend P19 just enough to start one authorized stdio MCP child from a
   repo-local definition and expose an explicit operation allowlist.
2. Add a Codebase Memory fixture definition with an operator-provided binary,
   disabled-by-default stages, version health check, repo-scoped cache, no
   network, and no personal-config mutation.
3. In scratch, record every file `index_repository` writes. Do not index a live
   target until shared graph and `.gitattributes` writes can be suppressed,
   redirected, or isolated.
4. Add a preflight/index helper that records version, workspace/revision
   identity, freshness, duration, and policy events in the run bundle.
5. Run architecture, call-chain, and change-impact fixtures through a
   harness-owned query path without injecting results into live prompts.
6. Compare off/on for answer quality, impact recall, tokens, tool calls, and
   index/query latency; set production thresholds from Otto's eval results.
7. Only after the spike passes, inject bounded graph results into selected
   stages, enforce current-source reads before edits, refresh before review, and
   add the `codebase-intelligence` profile.
