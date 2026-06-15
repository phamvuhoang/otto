# Always-on superpowers in the AFK loop — design

**Date:** 2026-06-14
**Status:** Approved (design), pending implementation plan
**Scope:** `@phamvuhoang/otto-core` templates only — no `loop.ts`/stage/chain code changes.

## Problem

Today the AFK loop trusts whatever input it gets: `otto-afk` reads the
plan/PRD paths in `<inputs>` and starts implementing; `otto-ghafk --issue`
reads the issue body and starts implementing. When the input is missing,
thin, or ambiguous ("make it better", a bare issue with no acceptance
criteria, no PRD at all), the agent guesses at scope with no recorded
reasoning and no plan to converge against.

We want the loop to **always apply the superpowers workflow** — brainstorm →
spec → plan → TDD — but to do so _adaptively_ and _without a human in the
loop_, since AFK runs detached with `bypassPermissions` and nobody present to
answer clarifying questions or approve a design.

## Decisions (locked during brainstorming)

1. **Autonomous brainstorm.** When input is unclear the agent plays both
   sides: it generates the clarifying questions the brainstorming skill would
   ask, answers each itself with the most reasonable repo-grounded default,
   records the assumptions, and proceeds. It does **not** stop or wait for
   approval. (No "brainstorm-without-a-human" skill exists; our playbook
   explicitly overrides the brainstorming skill's interactive HARD-GATE, which
   `using-superpowers` permits because user/project instructions outrank a
   skill's default behavior.)
2. **Agent-judged clarity trigger.** Each run: if a spec already exists on
   disk → implement against it; else the agent assesses clarity — clear enough
   → implement directly; ambiguous → brainstorm → spec → plan → implement.
   No wasted brainstorming on already-clear tasks.
3. **`.otto/` working memory for artifacts.** Spec → `.otto/specs/`, plan →
   `.otto/plans/`, git-tracked alongside `.otto/LEARNINGS.md`. Keeps
   machine-generated planning artifacts out of the project's `docs/` tree.
   Filenames are task-keyed for reliable re-discovery across iterations.
4. **TDD always; the loop drives tasks.** Enforce test-driven development every
   iteration (failing test → pass → refactor). Keep one-task-per-iteration —
   Otto's loop _is_ the task driver, so in-run sub-agent spawning is dropped
   as redundant (it would break the gate/budget/reviewer invariants that
   assume one task per run).

## Approach (chosen: A — playbook-only, shared include)

No new stage, no topology change. A single new template fragment
`templates/superpowers.md` is `@include`'d into the three existing agent
playbooks. The implementer stage is already gate index 0 and already emits the
`NO MORE TASKS` sentinel, so all loop invariants hold unchanged.

Rejected alternatives:

- **B — dedicated `clarify` gate stage.** Real wiring cost (`STAGES` entry +
  template + chain edits in `main.ts`, `gh-main.ts`, `issueStage`); creates a
  second gate that muddies `loop.ts`'s single-sentinel gate model; runs every
  iteration even once a spec exists. Over-engineered given decision #2 already
  makes the behavior adaptive within one run.
- **C — hybrid (B but skip when spec exists).** Still pays B's wiring cost; net
  worse than A.

## Architecture

Topology is unchanged:

```
otto-afk   → [implementer,            reviewer]
otto-ghafk → [ghafkImplementer,       reviewer]   (multi-issue)
otto-ghafk → [ghafkIssueImplementer,  reviewer]   (--issue)
```

The entire change is data (templates):

| File                                           | Change                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/core/templates/superpowers.md`       | **new** — self-contained clarity-gate + brainstorm + spec/plan + TDD protocol |
| `packages/core/templates/prompt.md`            | add `@include:superpowers.md` near the top (before TASK SELECTION)            |
| `packages/core/templates/ghprompt-workflow.md` | add `@include:superpowers.md` at the top (before EXPLORATION)                 |

`ghprompt-workflow.md` covers both gh paths: `ghafk-issue.md` includes it
directly; `ghafk.md` includes `ghprompt.md` which includes `ghprompt-workflow.md`
transitively. Adding the directive to `ghprompt.md` as well would double-include
the fragment and is intentionally avoided.

`superpowers.md` ships automatically — `packages/core`'s `files` glob already
includes `templates/`.

## The fragment protocol (data flow per iteration)

1. **Resolve the task key.**
   - ghafk `--issue` run → `issue-<OTTO_ISSUE>`.
   - ghafk multi-issue run → `issue-<the issue number being worked>`.
   - afk run → a stable slug derived from the primary plan-file basename (or a
     kebab of the task title when inputs are inline text).
2. **Look for an existing spec** at `.otto/specs/<task-key>-design.md`.
3. **Spec exists** → load it plus `.otto/plans/<task-key>.md`; pick the next
   unchecked plan task; TDD-implement it; update the plan's task status; commit
   (plan/spec/`LEARNINGS.md` committed _with_ the work, no separate commit).
   When the plan is fully checked **and** feedback loops are green → emit
   `<promise>NO MORE TASKS</promise>`.
4. **No spec → assess clarity.** Signals of "unclear": no PRD/plan provided at
   all; vague directive ("make it better"); missing acceptance criteria;
   multiple plausible interpretations; internal contradictions.
   - **Clear enough** → implement directly (optionally jot a lightweight plan).
   - **Unclear** → **autonomous brainstorm** (step 5).
5. **Autonomous brainstorm.** The agent:
   - generates the clarifying questions the brainstorming skill would ask;
   - answers each with the most reasonable repo-grounded default;
   - records `Q → chosen answer → rationale` in an **Assumptions** section of
     the spec;
   - picks the simplest viable approach (YAGNI);
   - writes the spec → `.otto/specs/<task-key>-design.md` and the plan →
     `.otto/plans/<task-key>.md`;
   - does **not** wait for approval — the written assumptions are the record;
   - implements the first plan task via TDD.
6. **TDD always** during implementation: write a failing test → make it pass →
   refactor, then run the existing feedback loops (`pnpm test`/`typecheck`,
   `dotnet test`/`build`, etc. per the playbook).

## Robustness — self-contained, skills optional

Otto runs `claude --print` against **arbitrary target repos** that may not
have the superpowers plugin installed. Therefore `superpowers.md` **embeds the
essential brainstorm/spec/plan/TDD protocol inline as plain instructions**, and
only _additionally_ notes: "if the `superpowers:brainstorming`,
`superpowers:writing-plans`, and `superpowers:test-driven-development` skills
are available, invoke them for fuller guidance." The loop behaves correctly
whether or not the plugin is present in the nested session.

## Idempotency & error handling

- Spec + plan are git-tracked and committed with the work (like
  `LEARNINGS.md`), so the next iteration rediscovers them and the loop
  converges instead of re-brainstorming every run.
- `.otto/specs` absent → treated as "first run, no spec"; the agent creates
  the directory.
- Genuinely blocking ambiguity (needs a secret or a human-only decision) →
  record the blocker in the spec + commit body, take the safest assumption,
  and make forward progress on unblocked parts. **Never hang** — it is AFK.
- Spec exists but is contradicted by the current code → the agent may amend the
  spec (noted in the commit body); keep amendments lightweight.

## Testing

- **Template-render tests** in `packages/core/src/__tests__/`: render
  `afk.md`, `ghafk.md`, and `ghafk-issue.md` and assert the clarity-gate text
  from `superpowers.md` is present (i.e. the `@include` resolved). Use the
  existing `renderTemplate` harness.
- Assert `templates/superpowers.md` exists and is included in the shipped
  `files` set.
- LLM behavior itself is not unit-testable → verify with a real smoke run: one
  deliberately-vague issue (should trigger brainstorm → spec in `.otto/specs/`)
  and one crisp plan (should skip brainstorm and implement directly).

## Non-goals (YAGNI)

- **No new CLI flag** — always-on per "always use superpowers". A
  `OTTO_SUPERPOWERS=0` opt-out is a possible future add; not built now.
- **No reviewer/panel changes.**
- **No `loop.ts` / stage / chain code changes.**
- **No in-run sub-agent dispatch** — the loop is the task driver (decision #4).
