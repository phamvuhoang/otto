# Design: P30 — context budget enforcement and state digest

Date: 2026-07-31
Status: Approved (brainstorm, decisions made on the operator's behalf — see [Decisions](#decisions)), pending spec review → plan refresh
Applies to: `--token-mode`, the render→spawn boundary in `stage-exec.ts`, the resume-note chain, and the context report.
Tracking: issue #249 (epic #245). Roadmap: `docs/HARNESS_ROADMAP_PHASE6.md` §P30.
Depends on: **P29 implementation** (spec merged as `50695c5`; no code yet) and, for one digest field, **P27 implementation** (`a3cd6e2`; no code yet). See [Dependencies](#dependencies).

## Problem

`context-budget.ts` and `context-report.ts` are explicitly "pure + INERT on the loop": they measure and recommend, and nothing acts. `assessContextBudget` (`context-budget.ts:114`) computes `overBudget`, `overByTokens`, and a `recommendation` naming the lever that would help — and the loop ships the prompt anyway.

Meanwhile:

- **`--token-mode reduce` is cosmetic.** `applyPromptReduction` (`prompt-reduction.ts:26`) compacts trailing whitespace and collapses blank runs; `TokenMode` is `"off" | "measure" | "reduce"` (`tokens.ts:1`) with no enforcing tier.
- **Prior-iteration state is re-derived, not carried.** Nothing writes a compact digest of what the run has established, so each iteration re-derives it from unbounded blobs.
- **The resume note is unbounded.** `loop.ts:1279` composes it from `formatPlanGate` + `formatPlanDepthRubric` + instructions with no ceiling, while the skills block has had `DEFAULT_SKILLS_BUDGET_CHARS = 4000` (`skill-routing.ts:24`) since P18.

## Outcome

When a stage's assembled context exceeds its budget, the harness degrades it through governed, recorded levers instead of shipping it anyway; stale re-derived state retires into a compact harness-written digest. **Off by default** — measure-only remains the default and un-opted runs are byte-for-byte unchanged.

## Decisions

The operator was remote. Each decision states its rationale so it can be reversed cheaply.

### D1 — `evidence` must join `REDUCIBLE_LEVERS`, or advice and enforcement disagree

The prior plan already gets the ladder right: `enforceContextBudget` applies a fixed ordered list (`bound-learnings` → `compress-spill` → `compact-commits`), not `assessContextBudget`'s single `recommendation`. That is the correct design and this spec keeps it.

The problem is on the **advisory** side, and it makes measure-mode and enforce-mode contradict each other.

`assessContextBudget` picks its recommendation like this (`context-budget.ts:128`):

```ts
const top = breakdown.segments.find((s) => s.category in REDUCIBLE_LEVERS);
```

and `REDUCIBLE_LEVERS` (`context-budget.ts:66-69`) contains **only** `commits` and `learnings`:

```ts
const REDUCIBLE_LEVERS: Partial<Record<ContextCategory, string>> = {
  commits: "inter-iteration commit compaction (compactCommits, slice 6)",
  learnings: "bounded learnings injection (boundLearnings, slice 5)",
};
```

`evidence` is absent — yet `evidence` is precisely the category the compressor is authorized to act on (`isCompressibleCategory` → `"issue-body"`), and it is the category that holds multi-KB pasted issue bodies and `<graph-map>` output.

Segments arrive sorted chars-descending, so `find` returns **the largest reducible one, skipping evidence entirely**. A prompt bloated by a 40 KB issue body produces a recommendation naming a 2 KB `<commits>` block.

That recommendation is what the plan's **Advisory** report section prints (`— would compact ${a.recommendation.category} via ${a.recommendation.lever}`). So on exactly the prompts enforcement helps most, the report advises compacting commits while the ladder's `compress-spill` rung is the rung that actually fires. The two halves of the same feature describe different levers, and `--context-report` on its own gives misleading advice today, before any enforcement exists.

**Therefore `evidence` is added to `REDUCIBLE_LEVERS`**, mapped to the compression lever. One line in a pure module with its own tests. It aligns advice with behavior, and it improves `--context-report` independently of enforcement — which is why it should land whether or not the rest of P30 does.

### D2 — enforcement is textual surgery, so it verifies itself and fails closed

Enforcement runs between render and spawn (`stage-exec.ts`), the only point where the final prompt string exists. That means rewriting a rendered prompt in place, which risks corrupting it.

Two invariants, both checked by re-running `analyzeContext` on the rewritten prompt:

- **`inputs` and `playbook` char counts must be unchanged.** These carry the task and the instructions; the roadmap's non-goal is explicit that task inputs are never cut.
- **Every recognized block tag present before must still be present after.** The ladder rewrites _contents_, never structure.

If either invariant fails, **discard the rewrite, ship the original prompt**, and record an enforcement event saying enforcement was skipped and why. A prompt that is over budget is a cost problem; a prompt that has been silently mangled is a correctness problem.

### D3 — stop at the first lever that fits; record every application; never truncate

Levers apply in order — tighter `boundLearnings` budget → authorized compression → `compactCommits` — re-assessing after each. The ladder stops as soon as the prompt is within budget. Each application records a `ContextEnforcementEvent` with its measured saving. If the prompt is still over budget after every lever, that is **recorded as still-over**, and the prompt ships intact. There is no truncation rung.

### D4 — the state digest is harness-written, never agent prose

The digest is built from the run manifest and stage records only — tasks done, current focus, open findings, last attested check state — mirroring P27's harness-only evidence rule (`checks`/`checksSummary` are never parsed from agent JSON). An agent-authored digest would be exactly the unverified self-report Phase 6 exists to eliminate.

It is bounded, rides the existing `RESUME` template var (no template changes), and links to the run bundle so the original evidence stays retrievable rather than lost.

**It must degrade gracefully when P27 has not shipped:** the "last attested check state" field is simply absent, and the digest renders without it.

### D5 — the resume note is bounded by dropping whole sections, never by mid-string truncation

The prior plan specifies `boundResumeNote` as **head-preserving with an elision marker**. That is the wrong end to keep here.

`loop.ts:1279` composes the plan-gate resume note in this order:

```ts
resumeNote = [
  "The authored plan failed Otto's semantic plan gate. Re-plan once before stopping.",
  formatPlanGate(gate),
  formatPlanDepthRubric(depth),
  `Rewrite ${planDoc.specPath} and ${planDoc.planPath}; keep the same task key unless the original key was wrong.`,
].join("\n\n");
```

The **actionable instruction is last**, and the two rubric renderings in the middle are the bulky parts. Head-preserving truncation therefore cuts precisely the sentence telling the agent which files to rewrite, leaving it with a diagnosis and no instruction.

The bound instead drops **whole sections by ascending priority** — rubric detail first, the actionable instruction never — mirroring `DEFAULT_SKILLS_BUDGET_CHARS = 4000` (`skill-routing.ts:24`) as the budget _pattern_ but not its truncation mechanics. When a section is dropped, the note says so.

### D6 — the compression lever can only compress what policy already authorizes

`isCompressibleCategory` returns true for `"issue-body"` only. P29's D6 deliberately gated `memory-projection` authorization on measurement, because authorizing a category obligates the P22 fact-survival gate (#200) for it.

P30 inherits that constraint rather than working around it: on a learnings-heavy prompt, enforcement can pull the tighter-`boundLearnings` lever but **not** the compression lever, unless P29's measurement authorized `memory-projection` first. Enforcement must not become a back door that authorizes a category the survival gate has not cleared.

## Architecture

- **`tokens.ts`** — `TokenMode` gains `"enforce"`; `parseTokenMode` (`:118`) accepts it. `enforce` implies everything `measure` does, plus the ladder.
- **`context-enforcement.ts`** (new, pure) — the ladder over the rendered prompt, rewriting only recognized block spans, with the D2 self-verification.
- **`context-budget.ts`** — `evidence` added to `REDUCIBLE_LEVERS` (D1).
- **`stage-exec.ts`** — invokes the ladder between render and spawn; attaches events to the stage record.
- **`state-digest.ts`** (new) — builds the bounded digest from manifest + stage records each iteration.
- **`loop.ts`** — supplies the learnings re-render hook (P29's `{{ LEARNINGS }}` path), bounds the resume note, aggregates events onto the manifest.
- **`context-report.ts`** — distinguishes **Enforced** (event with measured saving) from **Advisory** (over budget, lever not pulled).

## Data flow

```
renderTemplate → prompt
  ↓  (only when tokenMode === "enforce")
analyzeContext(prompt) → breakdown → assessContextBudget → overBudget?
  ↓ yes
ladder, in order, re-assessing after each:
   1. tighter boundLearnings budget   (re-render <learnings> via the P29 hook)
   2. authorized compression          (evidence only, per D6)
   3. compactCommits                  (<commits>)
  ↓
verify: inputs + playbook char counts unchanged, all tags still present   (D2)
  ↓ pass                              ↓ fail
use rewritten prompt                  discard; ship original; record "skipped"
  ↓
ContextEnforcementEvent[] → StageRecord → manifest → context report (Enforced vs Advisory)
```

## Error handling

| Condition                                           | Behavior                                                       |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `tokenMode !== "enforce"`                           | Ladder never runs. Byte-for-byte unchanged.                    |
| Within budget                                       | Ladder never runs; no events.                                  |
| Lever unavailable (e.g. no governed memory records) | Skipped, recorded as "lever unavailable", ladder continues.    |
| Compression category unauthorized (D6)              | Lever skipped with an explicit reason; never force-authorized. |
| Post-rewrite invariant violated (D2)                | Rewrite discarded, original prompt shipped, event recorded.    |
| Still over budget after all levers                  | Recorded as still-over. Prompt ships intact. Never truncated.  |
| P27 not implemented                                 | Digest omits the attested-check field (D4).                    |

## Success metrics

- Last-third tokens per iteration stay within the P22 target band of the first third on a long-run fixture, with enforcement on.
- No benchmark regression with enforcement on (survival evals green for every category the ladder touches).
- Every enforcement action appears in the context report with its measured saving; advisory-only cases are labelled as such.
- Default runs (no opt-in) are byte-for-byte unchanged.
- A fixture whose largest block is `evidence` gets a recommendation naming the compression lever, not `<commits>` (the D1 regression).

## Non-goals

- **No truncation rung** (D3). Task inputs and policy/safety content are never cut.
- **No new compressor authorization** (D6). Enforcement consumes the existing gate; it does not widen it.
- **No agent-authored digest** (D4).
- **No default-on behavior.** Measure-only stays the default.

## Dependencies

**P29 must be implemented first, not merely specced.** Its spec merged as `50695c5`, but no code exists: lever (a) re-renders `<learnings>` through the `{{ LEARNINGS }}` path P29 introduces, and the honest `--token-mode` reporting P30 extends is P29's Task 7. Both P30 Task 1 and P29 Task 7 modify `prompt-reduction.ts` and the `TokenMode` union, so **they conflict textually** — P29 must land first.

**P27 is a soft dependency**: the digest's attested-check field degrades to absent without it (D4).

Also depends on P22 lifecycle + survival evals and P7 telemetry.

## Deltas from the 2026-07-10 plan

1. **D1 is new, and narrower than it first appears.** The plan's _ladder_ is correctly a fixed ordered list, not recommendation-driven. But its **Advisory** report line prints `assessContextBudget`'s recommendation, and `REDUCIBLE_LEVERS` omits `evidence` — the one category the compressor is authorized to act on — so advice and enforcement name different levers on exactly the prompts enforcement helps most.
2. **D2's self-verification and fail-closed rule are new.** The prior plan constrains _which_ blocks may be rewritten but does not verify the result or define what happens when the rewrite goes wrong.
3. **D5 corrects the resume-note bound** from head-preserving truncation to section-priority dropping. Head-preserving would cut the actionable "rewrite these files" instruction, which is the last element of the composed note.
4. **D6 makes the authorization constraint explicit**, following P29's merged D6.
