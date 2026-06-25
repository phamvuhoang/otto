# Otto Harness Roadmap - Phase 4: Extensible Skills And Tool Authority

Last updated: 2026-06-25

Phase 1 ([`HARNESS_ENHANCEMENT_ROADMAP.md`](./HARNESS_ENHANCEMENT_ROADMAP.md),
P0-P6) made Otto governed, measurable, and adaptive. Phase 2
([`HARNESS_ROADMAP_PHASE2.md`](./HARNESS_ROADMAP_PHASE2.md), P7-P12) made it
efficient, legible, generative, and multi-agent. Phase 3
([`HARNESS_ROADMAP_PHASE3.md`](./HARNESS_ROADMAP_PHASE3.md), P13-P15) made the
plan, review, and report gates judge substance instead of artifact shape.

Phase 4 turns that governed harness into an extension host. Otto already has
repo-local skills, a safety policy, run evidence, model routing, fan-out,
context telemetry, and an always-on Superpowers-inspired workflow. The next gap
is that external knowledge and tools are still outside Otto's governance model:

- External skills can be mentioned in prompts, but Otto does not install, pin,
  normalize, validate, route, or report their use.
- Repo-local skills exist under `.otto/skills/`, but they are read-only
  inventory today. `skillsUsed[]` exists in the trajectory schema but is not
  populated by the loop.
- External tools are either hidden behind the agent CLI or invoked as shell
  commands. Otto has policy checks for shell tags, but not a typed authority
  layer for MCP servers, local services, proxies, or SDK adapters.
- Token-saving tools such as [Headroom](https://github.com/headroomlabs-ai/headroom)
  fit Otto's P7 context-efficiency thesis, but Otto needs a governed integration
  point before one compressor becomes a hard dependency.

**Thesis for Phase 4:** Otto should use outside skills and tools only when they
are versioned, policy-scoped, validated, selected for a concrete reason, and
visible in the evidence bundle. External capability should reduce cost and
improve quality without turning unattended runs into arbitrary plugin execution.

## Product And Research Inputs

- [obra/superpowers](https://github.com/obra/superpowers) is a mature agentic
  software-development methodology built around composable skills and an
  end-to-end workflow: brainstorm, worktree setup, detailed plans, sub-agent
  development or plan execution, TDD, review, and branch finishing. It supports
  many harnesses, including Codex App and Codex CLI, making it a good first
  external coding-skill source.
- [deanpeters/Product-Manager-Skills](https://github.com/deanpeters/Product-Manager-Skills)
  packages PM frameworks for agents, including prioritization, roadmap planning,
  discovery, PRDs, user stories, AI product readiness, and agent orchestration.
  It is a good test source because not every valuable Otto skill is a coding
  skill; plan, report, and issue-intake stages can benefit from PM judgment.
- [Headroom](https://github.com/headroomlabs-ai/headroom) targets the exact
  P7 cost problem: it compresses tool outputs, logs, RAG chunks, files, and
  history before they reach the model. It exposes library, proxy, wrapper, and
  MCP modes, advertises local-first reversible compression, and includes a
  TypeScript integration path. It is the first external tool adapter to test.
- Otto's own architecture already points here: Phase 1 P5 created skill
  packages, Phase 2 held MCP/tool authority below the line, and Phase 3 made
  reports and review strong enough to expose external decisions honestly.

## Strategy Context

### Business Outcomes

| Outcome                         | Why it matters                                                              | Candidate metric                                                                           |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Lower cost per successful task  | Long unattended runs are constrained by token spend.                        | cost per completed task; prompt tokens per iteration; compression savings at equal quality |
| Better work from better methods | External skill libraries encode proven workflows Otto should not re-invent. | plan depth score; review-fix commits per task; skill-assisted benchmark success            |
| Safe extensibility              | Users need ecosystem leverage without importing arbitrary authority.        | % external skills pinned and validated; policy-denied tool actions; zero secret leaks      |
| Inspectable decisions           | Maintainers must know why a skill or tool affected a run.                   | `skillsUsed[]`/`toolsUsed[]` coverage; `otto-skills why` and `otto-tools why` usefulness   |
| Ecosystem reach                 | Otto becomes the harness that can evaluate and govern agent extensions.     | external sources supported; extension fixtures in eval suite; docs adoption                |

### Target Users

- Solo maintainers who want Otto to reuse battle-tested workflows without
  manually copy-pasting large prompt blocks.
- Engineering teams that need auditable skill/tool usage before allowing agents
  to run AFK in production repositories.
- PMs and founders who want Otto to apply PM frameworks during plan, issue
  intake, and report generation, not only during code implementation.
- Tool builders who want a typed, policy-scoped way to make local services,
  MCP servers, SDKs, or proxies available to Otto.

## Current Position

Otto is ready for a governed extension layer, but the extension behavior is not
yet first class:

- `packages/core/templates/superpowers.md` is always included and can invoke
  installed `superpowers:*` skills if the nested agent happens to have them, but
  it is intentionally self-contained because target repos may not have the
  plugin installed.
- `packages/core/src/skills.ts` and `otto-skills` support repo-local skill
  packages, validation status, candidate detection, retrieval explanations, and
  stale/unvalidated audits. They are explicitly inert on the live loop.
- `packages/core/src/run-report.ts` has `SkillUsage` and `skillsUsed[]`, and
  `eval.ts` can count them, but no stage populates those fields.
- `packages/core/src/context-budget.ts`, `context-report.ts`, and
  `prompt-reduction.ts` give Otto measurement and conservative reduction, but
  there is no external compression provider.
- `packages/core/src/safety-policy.ts` governs shell tag commands and secrets
  for journal output, but there is no typed external-tool registry with
  per-stage authority, health checks, or approval gates.
- The Codex runtime runs with `--ignore-user-config`, which is correct for AFK
  safety, but it also means personal MCP servers and plugins are not inherited
  into unattended runs. Otto needs its own explicit extension configuration.

## Prioritized Initiatives

| Priority | Initiative                              | Outcome                                                                           | Size   | Confidence |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------- | ------ | ---------- |
| P16      | External skill source registry          | Import and pin outside skill packs without granting runtime authority.            | Medium | High       |
| P19      | External tool authority layer           | Register local services, MCP servers, proxies, and command adapters under policy. | Medium | High       |
| P20      | Headroom context-compression adapter    | Use Headroom to reduce prompt/tool-output tokens with measured quality parity.    | Medium | Medium     |
| P17      | Skill compatibility and validation gate | Prove imported skills are safe, compatible, and useful before auto-use.           | Large  | Medium     |
| P18      | Runtime skill activation and routing    | Apply validated skills during stages and record why they were used.               | Large  | Medium     |
| P21      | Curated extension profiles              | Ship opinionated, lockable bundles for common Otto jobs.                          | Medium | Medium     |

The order is deliberate: first make external inputs inspectable and pinned, then
make tool authority explicit, then test Headroom as the first high-value tool.
Only after imported skills have a compatibility and validation gate should Otto
let them influence live AFK runs.

---

## P16: External Skill Source Registry

**Outcome:** Otto can import external skill packs from Git repos, local
directories, or released archives into a pinned, inspectable, untrusted-by-default
source registry.

**Hypothesis:** If Otto can ingest external skills as versioned source packages
without auto-applying them, then users can bring in Superpowers, PM Skills, or
other libraries safely because import is separated from trust and runtime use.

**Scope:**

- Add an external source model:
  - `.otto/skills/sources.json` for configured sources.
  - `.otto/skills.lock.json` for resolved ref, checksum, import timestamp,
    source type, license metadata, and normalized package ids.
  - Source types: `git`, `local`, `archive`, and later `registry`.
- Extend `otto-skills` with read/write source commands:
  - `otto-skills sources list`
  - `otto-skills sources add <name> <url-or-path> --ref <sha-or-tag>`
  - `otto-skills sync --dry-run`
  - `otto-skills sync`
- Normalize common skill shapes into Otto's existing package shape:
  - `skills/<name>/SKILL.md`
  - `.codex-plugin` / `.claude-plugin` skill bundles
  - plain markdown instruction packs with a generated manifest
- Import every external skill as `trust: "unverified"` and
  `validation: {}`. The loop still cannot apply it until P17/P18.
- Preserve source provenance in each imported skill's `skill.json`: source name,
  upstream path, upstream ref, checksum, license, and normalized capabilities.
- Add `otto-skills audit --external` to surface unpinned refs, missing licenses,
  duplicate skill names, unsupported formats, and stale imported copies.

**Success metrics:**

- Superpowers and Product-Manager-Skills fixture snapshots can be imported
  without hand edits.
- `otto-skills list` shows imported skills with source, version/ref, trust, and
  validation state.
- `otto-skills sync --dry-run` is deterministic and shows exactly what would
  change.
- No imported skill can influence a run unless it is later validated and
  explicitly enabled.

**Dependencies:** Existing `skills.ts`, `skills-cli.ts`, run evidence bundle,
and safety policy.

---

## P19: External Tool Authority Layer

**Outcome:** Otto has a typed, policy-governed way to expose external tools,
local services, proxies, SDK adapters, and MCP servers to stages.

**Hypothesis:** If external tools are registered as explicit capabilities with
stage scope, command/network permissions, secrets, and health checks, then Otto
can use tools such as Headroom without relying on personal agent config or
unreviewed shell access.

**Scope:**

- Add a tool registry:
  - `.otto/tools/<name>.json` for repo-local tool definitions.
  - optional `.otto/config.json` `tools` block for enabling/disabling by stage.
  - `otto-tools list|audit|why|health` read-only operator surfaces.
- Define a small adapter contract:
  - `kind: "command" | "mcp" | "http" | "proxy" | "sdk"`.
  - capabilities, stage allowlist, command/env shape, network domains,
    write roots, secret refs, timeout, and health-check command.
  - output contract: structured result, estimated token savings if relevant,
    safety events, and retrieval handles for reversible outputs.
- Extend `.otto/policy.json` enforcement beyond shell render tags:
  - block tool invocations whose command/domain/write-root is not allowed.
  - support `approvalRequiredActions` for high-risk tool operations.
  - record tool policy denials as run `SafetyEvent`s.
- Add `ToolUsage` to run manifest and stage records, parallel to `SkillUsage`.
- Do not pass through personal MCP/plugin config from Claude or Codex. AFK tool
  authority must come only from Otto's repo-local registry.

**Success metrics:**

- A disabled or policy-blocked tool is never invoked and is visible in the run
  evidence.
- `otto-tools why <stage>` explains which tools would be available and why.
- Tool usage is present in the evidence bundle for 100% of successful tool
  invocations.
- Existing runs with no `.otto/tools/` behave exactly as today.

**Dependencies:** P0 trajectory, P4 safety policy, P10 operator surfaces, and
the agent-runtime boundary.

---

## P20: Headroom Context-Compression Adapter

**Outcome:** Otto can route selected prompt and tool-output content through
Headroom and measure token savings, cache behavior, latency, reversibility, and
quality impact.

**Hypothesis:** If Otto uses Headroom for the content categories that P7 already
identifies as token-heavy, then long-run token growth drops without hiding
evidence, because compression happens at a governed harness boundary and
original content remains retrievable when needed.

**Scope:**

- Add an off-by-default compressor setting:
  - `--context-compressor headroom`
  - `OTTO_CONTEXT_COMPRESSOR=headroom`
  - `.otto/config.json` `contextCompressor`
- Implement a Headroom adapter behind P19's tool contract. Prefer a local-first
  mode that does not require a hosted service:
  - TypeScript library path when stable enough for Otto's Node runtime.
  - MCP mode when the local MCP server is available.
  - proxy/wrapper mode only as an explicit advanced option, because it changes
    provider transport behavior.
- Start with measured, reversible compression targets:
  - spilled issue bodies and comments
  - command/log outputs before they are summarized into prompts
  - repeated prior-iteration context
  - large file/read artifacts that are already outside the stable playbook
  - memory projections when they exceed the P7 budget
- Preserve inspectability:
  - compressed artifact path, original artifact path or retrieval handle, token
    before/after, latency, and compressor version in stage records.
  - `otto-afk --context-report` includes compressor savings and retrieval count.
  - reports say when a run depended on compressed evidence.
- Add eval fixtures:
  - large issue dump where the correct answer requires one buried fact.
  - large log where the correct error signature must survive compression.
  - source file compression where line-level evidence must remain retrievable.
  - no-regression benchmark comparing `off`, `reduce`, and `headroom`.

**Success metrics:**

- Token input per iteration drops materially on large-context fixtures with no
  benchmark success regression.
- Compression savings, latency, and retrieval events are visible per stage.
- A failed or missing Headroom install degrades to Otto's existing behavior with
  a clear warning, not a broken run.
- Original evidence remains available in `.otto/runs/<run-id>/` or through a
  durable retrieval handle.

**Dependencies:** P7 context telemetry, P19 tool authority, P1 eval suite, and
P15 outcome-first reports.

---

## P17: Skill Compatibility And Validation Gate

**Outcome:** Imported skills can be evaluated for format, safety, interaction
style, AFK compatibility, and task value before they become eligible for use.

**Hypothesis:** If Otto validates external skills against both static rules and
small behavioral drills, then imported instruction packs improve runs without
bringing in stale, interactive, unsafe, or contradictory guidance.

**Scope:**

- Add `otto-skills validate <skill> [--source <name>]`:
  - static manifest/schema lint.
  - frontmatter/capability extraction.
  - instruction-risk scan: unsafe shell advice, secret handling, network use,
    interactive hard stops, unsupported tool assumptions, conflicting hierarchy.
  - license/provenance check.
- Add compatibility classifications:
  - `afk-safe`: can be applied without human interaction.
  - `interactive-only`: useful for `--plan` or human-guided modes, not AFK.
  - `stage-scoped`: valid only for plan, implement, review, report, journal, or
    tool-output compression stages.
  - `blocked`: violates policy or cannot be normalized.
- Add behavior drills to the eval suite:
  - Superpowers planning/TDD drill.
  - PM roadmap/PRD drill.
  - review-skill drill where the skill must not overrule repo policy.
- Persist validation back to `skill.json` via `recordValidation` plus new
  compatibility metadata.
- Keep validation separate from selection. A validated skill is eligible, not
  automatically applied.

**Success metrics:**

- Imported Superpowers and Product-Manager-Skills fixtures receive useful
  compatibility classifications.
- Interactive skills are not selected for AFK stages unless an autonomous
  adaptation is explicitly validated.
- Validation failures explain the exact blocker and remediation path.
- Revalidation catches a changed upstream skill before it is reused.

**Dependencies:** P16 source registry, P1 eval suite, P4 safety policy, and
existing `skillStatus`.

---

## P18: Runtime Skill Activation And Routing

**Outcome:** Otto can apply validated skills during live runs, bounded by stage
scope, risk, context budget, and policy, and the evidence bundle records which
skills shaped the run.

**Hypothesis:** If Otto selects only validated, relevant, bounded skill guidance
for each stage, then output quality rises and planning/review rework drops
without prompt bloat or hidden behavioral changes.

**Scope:**

- Add opt-in activation:
  - `--use-skills`
  - `OTTO_USE_SKILLS=1`
  - stage-specific config such as `skills.plan`, `skills.review`, `skills.report`.
- Extend retrieval:
  - capability tags by stage (`planning`, `tdd`, `code-review`,
    `roadmap-planning`, `prd`, `context-engineering`).
  - file/risk scope from existing `selectSkills`.
  - source trust and compatibility from P17.
  - token budget from P7, with a hard cap on injected skill text.
- Inject skills as bounded, attributed context:
  - include only the selected skill's relevant excerpt or summary, not a full
    external library.
  - label source/ref/checksum so reports can trace the instruction.
  - keep repo AGENTS instructions and Otto stage templates higher priority than
    imported skills.
- Populate `skillsUsed[]` on stage records and manifest with name, version/ref,
  source, selected stage, and retrieval reasons.
- Add `otto-skills why --stage <stage> --changed <path...>` and include selected
  skills in `otto-inspect`, `otto-explain`, and eval comparisons.
- Define conflict behavior: when two skills disagree, prefer repo policy and the
  most specific validated skill; report the conflict rather than silently mixing
  both.

**Success metrics:**

- Skill-assisted fixtures improve plan depth or reduce review-fix commits
  without increasing failures.
- `skillsUsed[]` is present for every stage where skill context was injected.
- Prompt token growth from skills stays within the configured context budget.
- Users can reproduce why a skill was selected from the evidence bundle alone.

**Dependencies:** P16, P17, P7 context budget, P14/P15 evidence surfacing, and
model/stage routing.

---

## P21: Curated Extension Profiles

**Outcome:** Otto ships curated, lockable extension profiles that combine skills,
tools, validation rules, and defaults for common jobs.

**Hypothesis:** If users can start from opinionated profiles instead of raw
source/tool configuration, then adoption rises while the governance model stays
explicit and inspectable.

**Scope:**

- Add profile manifests such as:
  - `coding-superpowers`: Superpowers coding skills, AFK-safe subset only.
  - `pm-planning`: PM roadmap, prioritization, PRD, and problem-framing skills
    for `--plan`, report, and issue-intake stages.
  - `context-saver`: Headroom adapter plus P7 context-report defaults.
  - `security-review`: security/structural review skills and stricter policy.
- Add `otto-extensions init <profile>` as a convenience wrapper that writes
  normal `.otto/skills/sources.json`, `.otto/tools/*.json`, and config entries.
- Publish a compatibility matrix:
  - supported source versions/refs.
  - tested Otto versions.
  - required local binaries/services.
  - known unsupported skill/tool features.
- Keep profiles as generated config, not hidden behavior. Users can inspect,
  edit, and diff the files they create.

**Success metrics:**

- A new repo can enable one profile and pass `otto-skills audit`,
  `otto-tools health`, and a smoke eval.
- Profile-generated config contains no broad unpinned refs and no default
  network/service authority beyond the profile's stated needs.
- Docs show how to update, lock, and roll back profiles.

**Dependencies:** P16-P20.

---

## Sequencing (Now / Next / Later)

```text
NOW - make external capability inspectable but inert
  P16  External skill source registry
  P19  External tool authority layer
  P20a Headroom benchmark spike behind the tool contract

NEXT - prove and activate the high-value paths
  P17  Skill compatibility and validation gate
  P20  Headroom production adapter
  P18  Runtime skill activation and routing

LATER - make the extension model easier to adopt
  P21  Curated extension profiles
```

**Why this order.** External skills and tools must be pinned and inspectable
before they are powerful. Headroom gets an early spike because token cost is a
live constraint and P7 already supplies measurement, but production use still
waits for the P19 authority layer. Skill activation waits for validation because
the failure mode is not just bad output; it is importing untrusted process as
trusted runtime instruction.

## Dependency Map

```text
P16 external skill registry
  -> P17 compatibility + validation
  -> P18 runtime skill activation

P19 external tool authority
  -> P20 Headroom adapter
  -> P21 context-saver profile

P7 context telemetry + P1 eval + P4 policy + P0 evidence
  -> every Phase 4 initiative
```

## Risks And Explicit Non-Goals

- **Do not build a marketplace first.** The first product is governance:
  sources, lockfiles, validation, and evidence. A marketplace without those
  primitives makes the trust problem worse.
- **Do not auto-trust famous repos.** Superpowers and PM Skills are strong first
  sources, not special security principals. They import as unverified until
  Otto validates them for the target stage.
- **Do not inherit personal agent config in AFK.** Personal MCP/plugin state is
  not reproducible, not repo-governed, and can change outside Otto's evidence
  model. Repo-local extension config is the source of truth.
- **Do not make Headroom mandatory.** It is a high-value adapter, but Otto must
  continue to run with no external compressor and must degrade cleanly when the
  service is unavailable.
- **Do not hide original evidence behind compression.** Compression can shorten
  context, but reports, evals, and reviewers still need access to originals or
  durable retrieval handles.
- **Do not let skills outrank repo instructions or safety policy.** Imported
  skills are advisory process context. Repo AGENTS, Otto stage contracts, and
  `.otto/policy.json` remain higher authority.
- **Do not broaden command execution through tools.** The tool layer narrows and
  records authority; it is not a bypass around the shell policy.

## First Implementation Slice

Recommended first slice: P16 safe external skill import with no live-loop
behavior change.

1. Define `ExternalSkillSource`, `ExternalSkillLock`, and imported-skill
   provenance fields in `skills.ts`.
2. Add read/write helpers for `.otto/skills/sources.json` and
   `.otto/skills.lock.json`; absent/malformed should follow Otto's existing
   safe-default pattern.
3. Add `otto-skills sources list/add/remove` and `otto-skills sync --dry-run`.
   The first implementation can support local fixture directories before adding
   networked git fetch.
4. Normalize `skills/<name>/SKILL.md` into `.otto/skills/<name>/skill.json` plus
   `instructions.md`, always `trust: "unverified"` and unvalidated.
5. Add fixture tests using small Superpowers-shaped and PM-Skills-shaped skill
   trees. Assert import, lock output, duplicate-name handling, and read-only dry
   run behavior.
6. Do not inject skills into prompts, do not mutate `skillsUsed[]`, and do not
   add runtime behavior in this slice.

The next thin slice should be P19's tool registry with a dummy local command
adapter and policy-denial tests. Only after that should the Headroom spike wire
real compression into a measured eval fixture.
