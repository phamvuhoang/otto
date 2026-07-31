# P31 Slice 2 — Interactive Sharpening, Traceability, Gate Everywhere — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three items P31's spec scoped to slice 2: ask a human up to 3 plan-changing questions when one is present, make `spec → plan task → verification artifact` one checkable chain, and let `--plan` gate ghafk/linear intake — each opt-in, each leaving today's default behavior byte-for-byte unchanged.

**Architecture:** Three independent strands sharing no state. (1) `input-sharpness.ts` gains a pure question-selection rule; a new `sharpening-prompt.ts` resolver asks them through the same injectable-read surface the plan checkpoint uses, and `loop.ts` calls it once before the plan stage. (2) `verification-matrix.ts` gains an optional `planTaskId` on `VerificationEntry`, carried through the existing tolerant parser and reported as plan-task coverage. (3) `gh-main.ts` / `linear-main.ts` gain a `planStage`, and two new issue-derived plan templates ship; the existing chain swap, gate, judge and checkpoint then apply unchanged.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥20, vitest. `packages/core` only. No new npm dependencies.

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **No new npm dependencies.**
- **Every strand is opt-in and inert by default.** Interactive questions require `--sharpen-input` **and** a TTY; `planTaskId` is optional on every row; `--plan` on ghafk/linear requires the flag. A run that opts into none of them renders, records and reports exactly as today.
- **AFK is never blocked.** A non-interactive run asks zero questions and keeps today's record-an-assumption guidance verbatim.
- **Never an interview tax.** A sharp input asks zero questions; questions map 1:1 to unmet sharpness dimensions and are individually skippable.
- **Harness-only evidence fields.** `planTaskId` is agent-supplied (unlike `attestedCheck`), so it is validated against the real `tasks.json` before it is trusted for coverage — an unmatched id is a gap, never silent credit.
- **Templates ship in the tarball** (`packages/core/package.json` `files: ["dist", "templates", "README.md"]`); new templates need no packaging change.
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit runs prettier + typecheck.
- **Never hand-edit release version state.** release-please owns it.
- **Conventional PR title.** `feat(p31): …` on a `packages/core` change bumps minor. `bump-minor-pre-major` is now set, so a `!` on a pre-1.0 package bumps minor — but `otto-core` is 1.2.0, where `!` means **2.0.0**. Do not use `!` unless a major is intended.

---

### Task 1: Question selection + the ask resolver (`sharpening-prompt.ts`)

**Files:**

- Modify: `packages/core/src/input-sharpness.ts` (append below `formatSharpeningGuidance` at `:147`)
- Create: `packages/core/src/sharpening-prompt.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/sharpening-questions.test.ts`

**Interfaces:**

- Consumes: `InputSharpnessScore` (`input-sharpness.ts:102`), `SHARPNESS_DIMENSIONS` order (`:40-56`), `PlanCheckpointDeps` (`plan-checkpoint.ts`) for the injectable read pattern.
- Produces:
  - `export const MAX_SHARPENING_QUESTIONS = 3;`
  - `export type SharpeningQuestion = { dimension: InputDimension; label: string; question: string };`
  - `export function selectSharpeningQuestions(score: InputSharpnessScore): SharpeningQuestion[]` — pure; unmet dimensions in scorecard order, capped at 3. Empty for a sharp input.
  - `export type SharpeningAnswer = { dimension: InputDimension; label: string; answer: string };`
  - `export function formatOperatorDimensions(answers: SharpeningAnswer[]): string` — pure; renders answered dimensions as an operator-provided block.
  - `export async function askSharpeningQuestions(score, deps): Promise<SharpeningAnswer[]>` (in `sharpening-prompt.ts`) — non-interactive ⇒ `[]` immediately; otherwise asks each question, treating empty input as skip.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/sharpening-questions.test.ts
import { describe, expect, it } from "vitest";
import {
  MAX_SHARPENING_QUESTIONS,
  formatOperatorDimensions,
  selectSharpeningQuestions,
} from "../input-sharpness.js";
import { scoreInputSharpness } from "../input-sharpness.js";
import { askSharpeningQuestions } from "../sharpening-prompt.js";

const SHARP = [
  "## Problem",
  "Users cannot reset a password.",
  "## Goal",
  "Ship a reset flow.",
  "## Constraints",
  "Must use the existing mailer.",
  "## Success criteria",
  "A user completes reset in under 2 minutes.",
  "## Scope",
  "Non-goals: SSO.",
].join("\n\n");

describe("selectSharpeningQuestions", () => {
  it("asks nothing when the input is sharp — never an interview tax", () => {
    expect(selectSharpeningQuestions(scoreInputSharpness(SHARP))).toEqual([]);
  });

  it("asks one question per unmet dimension, in scorecard order", () => {
    const qs = selectSharpeningQuestions(scoreInputSharpness("do the thing"));
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(MAX_SHARPENING_QUESTIONS);
    // Scorecard order is fixed, so `problem` precedes `goal`.
    const dims = qs.map((q) => q.dimension);
    expect(dims.indexOf("problem")).toBeLessThan(dims.indexOf("goal"));
  });

  it("caps at MAX_SHARPENING_QUESTIONS even when everything is unmet", () => {
    const qs = selectSharpeningQuestions(scoreInputSharpness("x"));
    expect(qs).toHaveLength(MAX_SHARPENING_QUESTIONS);
  });

  it("every question names its dimension so an answer can be attributed", () => {
    for (const q of selectSharpeningQuestions(scoreInputSharpness("x"))) {
      expect(q.question.length).toBeGreaterThan(10);
      expect(q.label.length).toBeGreaterThan(0);
    }
  });
});

describe("askSharpeningQuestions", () => {
  const deps = (answers: string[]) => {
    let i = 0;
    return {
      interactive: true,
      readLine: async () => answers[i++] ?? "",
      out: () => {},
    };
  };

  it("returns [] immediately in a non-interactive run (AFK never blocks)", async () => {
    let asked = 0;
    const out = await askSharpeningQuestions(scoreInputSharpness("x"), {
      interactive: false,
      readLine: async () => {
        asked += 1;
        return "never";
      },
      out: () => {},
    });
    expect(out).toEqual([]);
    expect(asked).toBe(0);
  });

  it("collects answers and attributes each to its dimension", async () => {
    const out = await askSharpeningQuestions(
      scoreInputSharpness("x"),
      deps(["users cannot reset", "ship a reset flow", "use the mailer"])
    );
    expect(out).toHaveLength(3);
    expect(out[0].dimension).toBe("problem");
    expect(out[0].answer).toBe("users cannot reset");
  });

  it("treats an empty answer as SKIP, not as an answer", async () => {
    const out = await askSharpeningQuestions(
      scoreInputSharpness("x"),
      deps(["", "ship a reset flow", "   "])
    );
    expect(out).toHaveLength(1);
    expect(out[0].dimension).toBe("goal");
  });

  it("asks nothing at all for a sharp input", async () => {
    let asked = 0;
    const out = await askSharpeningQuestions(scoreInputSharpness(SHARP), {
      interactive: true,
      readLine: async () => {
        asked += 1;
        return "x";
      },
      out: () => {},
    });
    expect(out).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe("formatOperatorDimensions", () => {
  it("is empty when nothing was answered", () => {
    expect(formatOperatorDimensions([])).toBe("");
  });

  it("renders answers as operator-provided, distinct from assumptions", () => {
    const out = formatOperatorDimensions([
      { dimension: "goal", label: "Goal / desired outcome", answer: "ship it" },
    ]);
    expect(out).toMatch(/operator/i);
    expect(out).toContain("Goal / desired outcome");
    expect(out).toContain("ship it");
    // An operator answer is fact, not an assumption to be recorded and checked.
    expect(out).not.toMatch(/assumption/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- sharpening-questions`
Expected: FAIL — `Cannot find module '../sharpening-prompt.js'`.

- [ ] **Step 3: Append the pure half to `input-sharpness.ts`**

```ts
/** Hard cap on questions asked before planning — never an interview tax. */
export const MAX_SHARPENING_QUESTIONS = 3;

export type SharpeningQuestion = {
  dimension: InputDimension;
  label: string;
  question: string;
};

/** One plain question per dimension, phrased so a one-line answer is useful. */
const DIMENSION_QUESTIONS: Record<InputDimension, string> = {
  problem: "What problem is this solving, and who is blocked by it today?",
  goal: "What should be true when this is done?",
  constraints:
    "What must this work within — existing systems, APIs, deadlines, or rules?",
  successCriteria: "How will you check it actually worked?",
  scope: "What is explicitly NOT part of this?",
};

/**
 * The questions worth asking a present human, in fixed scorecard order and
 * capped at {@link MAX_SHARPENING_QUESTIONS}.
 *
 * Empty for a sharp input — that is the "never an interview tax" property, and
 * it is the common case on a well-written plan/PRD. Pure.
 */
export function selectSharpeningQuestions(
  score: InputSharpnessScore
): SharpeningQuestion[] {
  return score.results
    .filter((r) => !r.met)
    .slice(0, MAX_SHARPENING_QUESTIONS)
    .map((r) => ({
      dimension: r.dimension,
      label: r.label,
      question: DIMENSION_QUESTIONS[r.dimension],
    }));
}

export type SharpeningAnswer = {
  dimension: InputDimension;
  label: string;
  answer: string;
};

/**
 * Render operator answers as an authoritative block.
 *
 * Deliberately does NOT use the word "assumption": `formatSharpeningGuidance`
 * tells the agent to record an assumption for each gap so a reviewer can
 * correct it. An answer from a present human is not an assumption — it is the
 * input, and the plan should treat it as given. Pure.
 */
export function formatOperatorDimensions(answers: SharpeningAnswer[]): string {
  if (answers.length === 0) return "";
  return [
    `## Operator-provided input (${answers.length})`,
    "",
    "A human answered these before planning. Treat them as part of the input, " +
      "not as gaps to assume around:",
    "",
    ...answers.map((a) => `- **${a.label}**: ${a.answer}`),
  ].join("\n");
}
```

- [ ] **Step 4: Create the resolver**

```ts
// packages/core/src/sharpening-prompt.ts
/**
 * Interactive sharpening questions (P31 slice 2, issue #250).
 *
 * When `--sharpen-input` finds unmet dimensions AND a human is present, ask up
 * to three plan-changing questions before the plan stage. Impure only in that
 * it reads lines through an injected surface — the same pattern
 * `resolvePlanCheckpoint` uses, so it is fully unit-testable with no TTY.
 *
 * A non-interactive run returns `[]` without asking anything, which is what
 * keeps AFK byte-for-byte unchanged.
 */
import {
  selectSharpeningQuestions,
  type InputSharpnessScore,
  type SharpeningAnswer,
} from "./input-sharpness.js";
import type { PlanCheckpointDeps } from "./plan-checkpoint.js";

export async function askSharpeningQuestions(
  score: InputSharpnessScore,
  deps: PlanCheckpointDeps
): Promise<SharpeningAnswer[]> {
  if (!deps.interactive) return [];
  const questions = selectSharpeningQuestions(score);
  if (questions.length === 0) return [];

  deps.out(
    `Input sharpening: ${questions.length} question(s) before planning. ` +
      "Press Enter to skip any of them."
  );
  const answers: SharpeningAnswer[] = [];
  for (const q of questions) {
    deps.out(`\n${q.label}\n  ${q.question}`);
    let raw = "";
    try {
      raw = await deps.readLine();
    } catch {
      // A closed stdin or an abort mid-interview: stop asking and proceed with
      // whatever was answered. Never block the run on an input surface.
      break;
    }
    const answer = raw.trim();
    if (answer.length === 0) continue; // skip
    answers.push({ dimension: q.dimension, label: q.label, answer });
  }
  return answers;
}
```

- [ ] **Step 5: Export from the package index**

Add `selectSharpeningQuestions`, `formatOperatorDimensions`, `MAX_SHARPENING_QUESTIONS`, `type SharpeningQuestion`, `type SharpeningAnswer` to the existing `./input-sharpness.js` export block, and a new block for `askSharpeningQuestions` from `./sharpening-prompt.js`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @phamvuhoang/otto-core test -- sharpening-questions`
Expected: PASS (12 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/input-sharpness.ts packages/core/src/sharpening-prompt.ts packages/core/src/index.ts packages/core/src/__tests__/sharpening-questions.test.ts
git commit -m "feat(p31): sharpening question selection + ask resolver"
```

---

### Task 2: Ask before planning, and stop the template claiming no human exists

**Files:**

- Modify: `packages/core/src/loop.ts` (sharpening block at `:479-489`; the plan stage's `SHARPENING` var at `:1760`)
- Modify: `packages/core/templates/plan.md` (`:27` — the "NO human available" claim)
- Test: `packages/core/src/__tests__/sharpening-wiring.test.ts`

**Interfaces:**

- Consumes: `askSharpeningQuestions` (Task 1), `formatOperatorDimensions` (Task 1), `formatSharpeningGuidance` (`input-sharpness.ts:147`), the shared `checkpointDeps` object (`loop.ts`, introduced by slice 1).
- Produces: no new exports. `sharpeningGuidance` becomes guidance **plus** an operator block when questions were answered.

> **The plan template asserts something slice 2 makes false.** `plan.md:27` says
> "There is NO human available during this run: act autonomously and record your
> reasoning instead of waiting for approval". After an interactive interview a
> human demonstrably _was_ available, and `formatSharpeningGuidance` repeats the
> claim ("No human is available — sharpen the input autonomously"). Leaving both
> in place while injecting operator answers tells the agent to assume around
> facts it has just been given. Step 3 fixes the template; Step 4 suppresses the
> redundant guidance for answered dimensions.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/sharpening-wiring.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatOperatorDimensions,
  formatSharpeningGuidance,
  scoreInputSharpness,
} from "../input-sharpness.js";
import { askSharpeningQuestions } from "../sharpening-prompt.js";

const tpl = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../templates/${name}`, import.meta.url)),
    "utf8"
  );

/** Mirror of the loop's composition of the `{{ SHARPENING }}` var. */
function composeSharpening(
  score: ReturnType<typeof scoreInputSharpness>,
  answers: Parameters<typeof formatOperatorDimensions>[0]
): string {
  const answered = new Set(answers.map((a) => a.dimension));
  const remaining = {
    ...score,
    results: score.results.filter((r) => !answered.has(r.dimension)),
    unknowns: score.results
      .filter((r) => !r.met && !answered.has(r.dimension))
      .map((r) => r.label),
  };
  return [
    formatOperatorDimensions(answers),
    formatSharpeningGuidance(remaining),
  ]
    .filter(Boolean)
    .join("\n\n");
}

describe("the SHARPENING var after an interview", () => {
  it("carries operator answers as input, not as gaps to assume around", async () => {
    const score = scoreInputSharpness("do the thing");
    const answers = await askSharpeningQuestions(score, {
      interactive: true,
      readLine: async () => "users cannot reset their password",
      out: () => {},
    });
    const out = composeSharpening(score, answers);
    expect(out).toContain("users cannot reset their password");
    // The answered dimension must not also be listed as an unknown to assume.
    expect(out).not.toMatch(/does not clearly state.*Problem \/ context/s);
  });

  it("still guides autonomous sharpening for dimensions left unanswered", () => {
    const score = scoreInputSharpness("do the thing");
    const out = composeSharpening(score, [
      { dimension: "problem", label: "Problem / context (why)", answer: "x" },
    ]);
    expect(out).toMatch(/sharpen the input autonomously|Otto scored/);
  });

  it("is byte-identical to today when no questions were answered", () => {
    const score = scoreInputSharpness("do the thing");
    expect(composeSharpening(score, [])).toBe(formatSharpeningGuidance(score));
  });
});

describe("plan.md no longer asserts a human cannot exist", () => {
  it("does not claim NO human is available", () => {
    // An interactive run has just interviewed one. The template must not tell
    // the agent to assume around facts it was handed.
    expect(tpl("plan.md")).not.toContain("There is NO human available");
  });

  it("still tells an unattended run to record assumptions and proceed", () => {
    expect(tpl("plan.md")).toMatch(/record.*assumption|act autonomously/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- sharpening-wiring`
Expected: FAIL — `plan.md` still contains "There is NO human available".

- [ ] **Step 3: Rewrite the template's claim (`plan.md:26-28`)**

Before:

```
world-class, structured **spec** and a task-decomposed **plan**, persisted for
human review _before_ any code is written. There is NO human available during
this run: act autonomously and **record your reasoning** instead of waiting for
approval ("record assumptions and proceed").
```

After:

```
world-class, structured **spec** and a task-decomposed **plan**, persisted for
human review _before_ any code is written. Assume no human is available to
answer questions mid-run unless the `{{ SHARPENING }}` block below says one
already answered: act autonomously and **record your reasoning** instead of
waiting for approval ("record assumptions and proceed").
```

- [ ] **Step 4: Wire the interview into the loop**

Replace the sharpening block (`loop.ts:479-489`):

```ts
const inputSharpness =
  sharpenInput && mode === "plan" ? scoreInputSharpness(inputs) : null;
// P31 slice 2: when a human is present, ask up to 3 questions mapped to the
// unmet dimensions. Answers become part of the input; only the dimensions
// still unanswered keep the record-an-assumption guidance, so the agent is
// never told to assume around a fact it was just given.
let sharpeningAnswers: SharpeningAnswer[] = [];
let sharpeningGuidance = inputSharpness
  ? formatSharpeningGuidance(inputSharpness)
  : "";
```

and, immediately before the plan stage runs (inside the async run body, after
`checkpointDeps` is in scope):

```ts
if (inputSharpness) {
  sharpeningAnswers = await askSharpeningQuestions(
    inputSharpness,
    checkpointDeps
  );
  if (sharpeningAnswers.length > 0) {
    const answered = new Set(sharpeningAnswers.map((a) => a.dimension));
    const remaining = {
      ...inputSharpness,
      results: inputSharpness.results.filter((r) => !answered.has(r.dimension)),
      unknowns: inputSharpness.results
        .filter((r) => !r.met && !answered.has(r.dimension))
        .map((r) => r.label),
    };
    sharpeningGuidance = [
      formatOperatorDimensions(sharpeningAnswers),
      formatSharpeningGuidance(remaining),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}
```

Record the answered dimensions on the manifest's `inputSharpness` block by
removing them from `unknowns` — a dimension a human answered is no longer an
unknown the run had to assume, and the report should not list it as one.

- [ ] **Step 5: Run the full suite**

Run: `pnpm -r typecheck && pnpm --filter @phamvuhoang/otto-core test`
Expected: PASS. Non-interactive runs take the `[]` path, so every existing plan
test is unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/loop.ts packages/core/templates/plan.md packages/core/src/__tests__/sharpening-wiring.test.ts
git commit -m "feat(p31): ask up to 3 sharpening questions when a human is present"
```

---

### Task 3: `planTaskId` on matrix rows

**Files:**

- Modify: `packages/core/src/verification-matrix.ts` (`VerificationEntry` at `:39-73`; `coerceEntry` at `:162`)
- Modify: `packages/core/templates/verify.md` (the matrix JSON contract at `:56-80`)
- Test: `packages/core/src/__tests__/matrix-plan-task-id.test.ts`

**Interfaces:**

- Consumes: `PlanTask.id` (`plan-tasks.ts:14`), `readPlanTasks` (`:86`).
- Produces:
  - `VerificationEntry.planTaskId?: string;`
  - `coerceEntry` carries a string `planTaskId` through; anything else is dropped.

> **Unlike `attestedCheck`, this field IS agent-supplied**, so it must not be
> trusted on sight. Task 4 validates every id against the real `tasks.json`; an
> id that matches nothing is a gap, never silent coverage credit.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/matrix-plan-task-id.test.ts
import { describe, expect, it } from "vitest";
import { parseVerificationMatrix } from "../verification-matrix.js";

const row = (over: Record<string, unknown> = {}) => ({
  requirement: "adds two numbers",
  method: "test",
  result: "pass",
  check: "pnpm -r test",
  ...over,
});

describe("planTaskId on matrix rows", () => {
  it("carries a string id through the parser", () => {
    const e = parseVerificationMatrix(
      JSON.stringify([row({ planTaskId: "T3" })])
    );
    expect(e[0].planTaskId).toBe("T3");
  });

  it("is absent when the row does not cite one", () => {
    const e = parseVerificationMatrix(JSON.stringify([row()]));
    expect(e[0].planTaskId).toBeUndefined();
  });

  it("drops a non-string id rather than trusting it", () => {
    const e = parseVerificationMatrix(
      JSON.stringify([row({ planTaskId: { evil: true } })])
    );
    expect(e[0].planTaskId).toBeUndefined();
  });

  it("does not change how a row without an id is otherwise parsed", () => {
    const withId = parseVerificationMatrix(
      JSON.stringify([row({ planTaskId: "T1" })])
    )[0];
    const withoutId = parseVerificationMatrix(JSON.stringify([row()]))[0];
    const { planTaskId, ...rest } = withId;
    expect(rest).toEqual(withoutId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- matrix-plan-task-id`
Expected: FAIL — `planTaskId` is not a property of `VerificationEntry` (typecheck) and the first assertion misses.

- [ ] **Step 3: Add the field**

In `VerificationEntry`, beside `check`:

```ts
  /** Id of the plan task (`tasks.json` `PlanTask.id`) this row verifies, when
   *  the run was plan-gated (P31 slice 2). Agent-supplied — validated against
   *  the real task set before it earns coverage credit; an id matching nothing
   *  is reported as a gap. Absent ⇒ the row is not traced to a plan task. */
  planTaskId?: string;
```

In `coerceEntry`, beside the other optional string fields:

```ts
    ...(typeof r.planTaskId === "string" && r.planTaskId
      ? { planTaskId: r.planTaskId }
      : {}),
```

- [ ] **Step 4: Ask for it in the verify template**

In `verify.md`'s matrix contract, add the field to the JSON shape and one line of guidance:

```
    "planTaskId": "<the plan task id from .otto/tasks/<key>/tasks.json this row verifies; omit if the run had no plan>",
```

> Cite the plan task id when this run was plan-gated. It makes
> `spec → task → verification artifact` one checkable chain; a task with no
> verifying row is reported as an explicit gap rather than assumed done.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @phamvuhoang/otto-core test -- matrix`
Expected: PASS — the new suite plus every existing matrix test unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/verification-matrix.ts packages/core/templates/verify.md packages/core/src/__tests__/matrix-plan-task-id.test.ts
git commit -m "feat(p31): matrix rows can cite the plan task they verify"
```

---

### Task 4: Plan-task coverage — validated, with unmatched ids as gaps

**Files:**

- Modify: `packages/core/src/verification-matrix.ts` (new `summarizePlanTaskCoverage` beside `reconcileMatrixWithPlan` at `:295`)
- Modify: `packages/core/src/report-finalize.ts` (render coverage next to the existing matrix output)
- Modify: `packages/core/src/loop.ts` (call it in verify mode beside `reconcileMatrixWithPlan`)
- Test: `packages/core/src/__tests__/plan-task-coverage.test.ts`

**Interfaces:**

- Consumes: `VerificationEntry.planTaskId` (Task 3), `readPlanTasks(workspaceDir, taskKey)` (`plan-tasks.ts:86`).
- Produces:
  - `export type PlanTaskCoverage = { verified: string[]; unverified: string[]; unmatched: string[]; ratio: number };`
  - `export function summarizePlanTaskCoverage(entries: VerificationEntry[], taskIds: string[]): PlanTaskCoverage` — pure. `unmatched` = ids cited by rows that no plan task has.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/plan-task-coverage.test.ts
import { describe, expect, it } from "vitest";
import {
  summarizePlanTaskCoverage,
  type VerificationEntry,
} from "../verification-matrix.js";

const row = (planTaskId?: string): VerificationEntry => ({
  requirement: "r",
  method: "test",
  check: "c",
  result: "pass",
  confidence: "medium",
  ...(planTaskId ? { planTaskId } : {}),
});

describe("summarizePlanTaskCoverage", () => {
  it("splits verified from unverified plan tasks", () => {
    const c = summarizePlanTaskCoverage(
      [row("T1"), row("T3")],
      ["T1", "T2", "T3"]
    );
    expect(c.verified).toEqual(["T1", "T3"]);
    expect(c.unverified).toEqual(["T2"]);
    expect(c.ratio).toBeCloseTo(2 / 3);
  });

  it("reports an id no plan task has as UNMATCHED, never as coverage", () => {
    // planTaskId is agent-supplied. An id that matches nothing must not earn
    // credit — that is exactly how a fabricated citation would inflate
    // coverage.
    const c = summarizePlanTaskCoverage([row("T1"), row("T99")], ["T1", "T2"]);
    expect(c.verified).toEqual(["T1"]);
    expect(c.unmatched).toEqual(["T99"]);
    expect(c.ratio).toBeCloseTo(1 / 2);
  });

  it("counts a task once however many rows cite it", () => {
    const c = summarizePlanTaskCoverage([row("T1"), row("T1")], ["T1", "T2"]);
    expect(c.verified).toEqual(["T1"]);
    expect(c.ratio).toBeCloseTo(1 / 2);
  });

  it("ignores rows that cite no task", () => {
    const c = summarizePlanTaskCoverage([row(), row("T1")], ["T1"]);
    expect(c.verified).toEqual(["T1"]);
    expect(c.unmatched).toEqual([]);
  });

  it("is empty and ratio 0 when the run had no plan tasks", () => {
    const c = summarizePlanTaskCoverage([row("T1")], []);
    expect(c.verified).toEqual([]);
    expect(c.unverified).toEqual([]);
    expect(c.unmatched).toEqual(["T1"]);
    expect(c.ratio).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- plan-task-coverage`
Expected: FAIL — `summarizePlanTaskCoverage` is not exported.

- [ ] **Step 3: Implement**

```ts
export type PlanTaskCoverage = {
  /** Plan task ids with at least one verifying row. */
  verified: string[];
  /** Plan task ids no row verifies — explicit gaps, not assumed done. */
  unverified: string[];
  /** Ids cited by rows that no plan task has. */
  unmatched: string[];
  /** verified / total plan tasks; 0 when the run had no plan tasks. */
  ratio: number;
};

/**
 * Score `spec → plan task → verification artifact` as one checkable chain
 * (P31 slice 2).
 *
 * `planTaskId` is agent-supplied, so an id matching no real plan task is
 * reported as `unmatched` and earns NO coverage credit — otherwise a
 * fabricated citation would inflate the very number it is meant to prove.
 * Pure.
 */
export function summarizePlanTaskCoverage(
  entries: VerificationEntry[],
  taskIds: string[]
): PlanTaskCoverage {
  const known = new Set(taskIds);
  const cited = new Set(
    entries.map((e) => e.planTaskId).filter((id): id is string => Boolean(id))
  );
  const verified = taskIds.filter((id) => cited.has(id));
  return {
    verified,
    unverified: taskIds.filter((id) => !cited.has(id)),
    unmatched: [...cited].filter((id) => !known.has(id)).sort(),
    ratio: taskIds.length === 0 ? 0 : verified.length / taskIds.length,
  };
}
```

- [ ] **Step 4: Render it and wire it**

In `report-finalize.ts`, add a `formatPlanTaskCoverage(coverage)` that renders
`N/M plan tasks verified`, lists unverified ids as gaps, and lists unmatched ids
as **"cited but not found in the plan"** — the two must read differently, since
one is missing work and the other is a bad citation.

In `loop.ts`, in verify mode beside the existing `reconcileMatrixWithPlan` call,
compute coverage from `readPlanTasks(workspaceDir, planDoc.taskKey).map(t => t.id)`
when a matching plan exists, and thread it onto the finalize context.

- [ ] **Step 5: Run the full suite**

Run: `pnpm -r typecheck && pnpm --filter @phamvuhoang/otto-core test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/verification-matrix.ts packages/core/src/report-finalize.ts packages/core/src/loop.ts packages/core/src/__tests__/plan-task-coverage.test.ts
git commit -m "feat(p31): plan-task coverage, with unmatched ids as gaps not credit"
```

---

### Task 5: Gate everywhere — `--plan` on ghafk and linear

**Files:**

- Create: `packages/core/templates/ghafk-plan.md`, `packages/core/templates/linearafk-plan.md`
- Modify: `packages/core/src/stages.ts` (add `ghafkPlan`, `linearPlan` to `STAGES`)
- Modify: `packages/core/src/gh-main.ts` (`:11-19`), `packages/core/src/linear-main.ts` (`:13-19`)
- Test: `packages/core/src/__tests__/plan-gate-everywhere.test.ts`

**Interfaces:**

- Consumes: the existing `--plan` rejection (`run-bin.ts:570-573`) and chain swap (`:634`) — **neither changes**; supplying a `planStage` is the whole fix.
- Produces: `STAGES.ghafkPlan` / `STAGES.linearPlan`, both `tier: "strong"` like `STAGES.plan`, and a `planStage` on each bin config.

> These are real chain stages, so per CLAUDE.md they go in `STAGES` **with a
> tier** and get a template — unlike the harness-orchestrated substages
> (`review-confirm`, panel lenses) which stay local consts.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/plan-gate-everywhere.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STAGES } from "../stages.js";

const templatesDir = fileURLToPath(new URL("../../templates", import.meta.url));
const tpl = (n: string) => readFileSync(`${templatesDir}/${n}`, "utf8");

describe("plan stages exist for every intake bin", () => {
  it("registers a plan stage for ghafk and linear", () => {
    expect(STAGES.ghafkPlan?.name).toBe("ghafk-plan");
    expect(STAGES.linearPlan?.name).toBe("linear-plan");
  });

  it("gives them the same strong tier as the afk plan stage", () => {
    expect(STAGES.ghafkPlan.tier).toBe(STAGES.plan.tier);
    expect(STAGES.linearPlan.tier).toBe(STAGES.plan.tier);
  });

  it("ships a template for each, and it exists on disk", () => {
    for (const s of [STAGES.ghafkPlan, STAGES.linearPlan]) {
      expect(readdirSync(templatesDir)).toContain(s.template);
    }
  });

  it("the issue-derived plan templates plan, and never implement", () => {
    for (const name of ["ghafk-plan.md", "linearafk-plan.md"]) {
      const t = tpl(name);
      expect(t).toMatch(/DO NOT IMPLEMENT/i);
      // It must author the same artifacts the gate scores.
      expect(t).toContain("spec.md");
      expect(t).toContain("plan.md");
    }
  });

  it("ghafk-plan derives its input from the issue, not from {{ INPUTS }} alone", () => {
    expect(tpl("ghafk-plan.md")).toContain("<issue");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- plan-gate-everywhere`
Expected: FAIL — `STAGES.ghafkPlan` is undefined.

- [ ] **Step 3: Write the two templates**

Model both on `plan.md`: same "PLAN — DO NOT IMPLEMENT" framing, same
spec/plan artifact contract and `{{ SHARPENING }}` block, but the input is the
issue rather than `{{ INPUTS }}`. `ghafk-plan.md` reuses `ghafk-issue.md`'s
issue block (`gh issue view "$OTTO_ISSUE"` plus the spilled body and
`@include:untrusted-content.md`); `linearafk-plan.md` reuses `linearafk-issue.md`'s.

Both must keep `@include:untrusted-content.md` inside the issue block — an
issue body is untrusted input whether it is being implemented or planned from.

- [ ] **Step 4: Register the stages and the bin configs**

In `stages.ts`, beside `plan`:

```ts
  ghafkPlan: {
    name: "ghafk-plan",
    template: "ghafk-plan.md",
    permissionMode: "bypassPermissions",
    tier: "strong",
  } satisfies Stage,
  linearPlan: {
    name: "linear-plan",
    template: "linearafk-plan.md",
    permissionMode: "bypassPermissions",
    tier: "strong",
  } satisfies Stage,
```

In `gh-main.ts` add `planStage: STAGES.ghafkPlan,`; in `linear-main.ts` add
`planStage: STAGES.linearPlan,`. Nothing else changes: `run-bin.ts:570` stops
rejecting `--plan` because `cfg.planStage` is now defined, and the existing
chain swap, gate, judge and checkpoint apply as they do for `otto-afk`.

- [ ] **Step 5: Run the tests**

Run: `pnpm -r typecheck && pnpm --filter @phamvuhoang/otto-core test`
Expected: PASS. Flag-absent runs on every bin are unchanged — `planStage` is
only consulted when `flags.plan` is set.

- [ ] **Step 6: Commit**

```bash
git add packages/core/templates/ghafk-plan.md packages/core/templates/linearafk-plan.md packages/core/src/stages.ts packages/core/src/gh-main.ts packages/core/src/linear-main.ts packages/core/src/__tests__/plan-gate-everywhere.test.ts
git commit -m "feat(p31): --plan gates ghafk and linear intake too"
```

---

### Task 6: Docs, roadmap, and full verify

**Files:**

- Modify: `README.md`, `docs/CONFIG.md`, `docs/CLI.md`, `docs/ARCHITECTURE.md`, `docs/HARNESS_ROADMAP_PHASE6.md`
- Modify: `docs/superpowers/specs/2026-07-10-p31-plan-soundness-design.md` (mark slice 2 shipped)

- [ ] **Step 1: Document the three behaviors**

- `docs/CLI.md` + `README.md`: `--plan` now works on `otto-ghafk` and
  `otto-linear-afk`, and `--sharpen-input` asks up to 3 questions when a TTY is
  present. State plainly that an unattended run asks none.
- `docs/CONFIG.md`: the interview is bounded at 3 questions, each skippable, and
  never runs without `--sharpen-input`.
- `docs/ARCHITECTURE.md`: extend the P31 section with the three strands, and
  say why `planTaskId` is validated while `attestedCheck` is not — one is
  agent-supplied, the other harness-written.

- [ ] **Step 2: Roadmap**

Mark P31 fully shipped in the priority table and reconcile the status note (it
currently says slice 2 "is the only Phase 6 work remaining").

- [ ] **Step 3: Full verify**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(p31): docs + roadmap for slice 2"
```

---

## Self-Review Notes

- **Spec coverage.** The spec's three slice-2 bullets map to: interactive
  sharpening = T1 (substrate) + T2 (wiring); traceability = T3 (field) + T4
  (validated coverage); gate-everywhere = T5. T6 is docs. Every bullet has a
  task, and no task exists without a spec bullet behind it.
- **Deliberately out of scope.** The spec's "new integration opportunity" — the
  judge scoring a plan's verify commands against P27's configured `checks` — is
  _not_ planned here. It would couple the judge's score to repo state, and
  spec Decision 3 requires the judge to read the document only, with any
  comparison arriving as a rendered var. It needs its own design decision
  first.
- **Type consistency.** `SharpeningAnswer` (T1) is consumed by T2;
  `VerificationEntry.planTaskId` (T3) by T4; `PlanTaskCoverage` (T4) by the
  report. `STAGES.ghafkPlan`/`linearPlan` (T5) are consumed only by the bin
  configs.
- **Ordering.** T1 → T2 and T3 → T4 are hard sequences. T5 is independent of
  both and can land in any order. T6 last.
- **Backward compatibility, pinned by tests.** Non-interactive sharpening
  returns `[]` (T1); the composed `SHARPENING` var is byte-identical with no
  answers (T2); a row without `planTaskId` parses exactly as before (T3);
  flag-absent runs on every bin are unchanged (T5).
- **The one behavior change worth calling out in review:** `plan.md`'s "There
  is NO human available" becomes conditional. Every `--plan` run sees the new
  wording, including unattended ones — which is why T2 keeps an explicit
  "act autonomously / record assumptions" instruction for the unattended case
  rather than simply deleting the sentence.

## Anchors verified against `main` (2026-07-31, `otto-core@1.2.0`)

| Anchor                                     | What                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `input-sharpness.ts:102`                   | `InputSharpnessScore`                                |
| `input-sharpness.ts:121`                   | `scoreInputSharpness`                                |
| `input-sharpness.ts:147`                   | `formatSharpeningGuidance`                           |
| `loop.ts:479-489`                          | the sharpening block                                 |
| `loop.ts:1760`                             | `SHARPENING:` var at the plan stage                  |
| `plan.md:27`                               | "There is NO human available"                        |
| `plan-tasks.ts:14` / `:86`                 | `PlanTask` / `readPlanTasks`                         |
| `verification-matrix.ts:39-73`             | `VerificationEntry`                                  |
| `verification-matrix.ts:162`               | `coerceEntry`                                        |
| `verification-matrix.ts:295`               | `reconcileMatrixWithPlan`                            |
| `run-bin.ts:570-573`                       | the `--plan is only supported by otto-afk` rejection |
| `run-bin.ts:634`                           | the plan-mode chain swap                             |
| `gh-main.ts:11-19`, `linear-main.ts:13-19` | bin configs needing `planStage`                      |
