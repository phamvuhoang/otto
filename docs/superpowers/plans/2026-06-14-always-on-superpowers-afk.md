# Always-on superpowers in the AFK loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Otto AFK iteration run an adaptive brainstorm → spec → plan → TDD workflow, autonomously (no human in the loop), via one new template fragment included into the agent playbooks.

**Architecture:** Templates-only change. A new self-contained fragment `packages/core/templates/superpowers.md` is `@include`'d into `prompt.md` (afk path) and `ghprompt-workflow.md` (both gh paths — it is shared by `ghafk-issue.md` directly and by `ghafk.md` transitively). No `loop.ts`/stage/chain code changes. Behavior is driven entirely by the prompt the nested `claude --print` agent receives.

**Tech Stack:** ESM TypeScript (`packages/core`), Vitest for unit tests, the existing `renderTemplate` harness (`packages/core/src/render.ts`) which resolves `@include:<path>` relative to the template's directory (absolute include paths supported).

---

## File Structure

| File                                                                    | Responsibility                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/templates/superpowers.md`                                | **New.** The always-on protocol: task-key resolution, clarity gate, autonomous brainstorm, TDD implement. Self-contained (works whether or not the superpowers plugin is installed in the nested session). |
| `packages/core/templates/prompt.md`                                     | **Modify.** Add `@include:superpowers.md` immediately before `# TASK SELECTION` (afk path).                                                                                                                |
| `packages/core/templates/ghprompt-workflow.md`                          | **Modify.** Add `@include:superpowers.md` at the very top, before `# EXPLORATION` (covers both ghafk paths).                                                                                               |
| `packages/core/src/__tests__/superpowers-include.test.ts`               | **New.** Asserts (a) the two playbooks contain the include directive and (b) `renderTemplate` resolves the fragment so the `CLARITY GATE` marker appears in output.                                        |
| `docs/superpowers/specs/2026-06-14-always-on-superpowers-afk-design.md` | **Modify.** Correct the component table from three edited files to two (no double-include), keeping spec and plan consistent.                                                                              |

**Deviation from spec, noted:** the spec's component table listed `ghprompt.md` as a third edit site. Because `ghprompt.md` ends with `@include:ghprompt-workflow.md`, editing `ghprompt-workflow.md` alone covers the multi-issue path too; adding the include to `ghprompt.md` as well would inject the fragment twice. Task 5 fixes the spec table.

---

## Task 1: Failing test for include wiring + render

**Files:**

- Test: `packages/core/src/__tests__/superpowers-include.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";

const tpl = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

describe("always-on superpowers fragment", () => {
  it("is included by the afk and ghafk-workflow playbooks", () => {
    for (const name of ["prompt.md", "ghprompt-workflow.md"]) {
      const body = readFileSync(tpl(name), "utf8");
      expect(body).toContain("@include:superpowers.md");
    }
  });

  it("renders the CLARITY GATE marker when its include is resolved", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-sp-"));
    const wrap = join(dir, "wrap.md");
    // Absolute include path -> renderTemplate reads the real fragment.
    writeFileSync(wrap, `@include:${tpl("superpowers.md")}`, "utf8");
    const out = renderTemplate(wrap, { INPUTS: "" });
    expect(out).toContain("CLARITY GATE");
    expect(out).toContain("AUTONOMOUS BRAINSTORM");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- superpowers-include`
Expected: FAIL — `prompt.md` lacks the include directive, and `templates/superpowers.md` does not exist (ENOENT on render).

---

## Task 2: Create the `superpowers.md` fragment

**Files:**

- Create: `packages/core/templates/superpowers.md`

- [ ] **Step 1: Write the fragment**

Write `packages/core/templates/superpowers.md` with exactly this content:

```markdown
# SUPERPOWERS WORKFLOW (always on)

Run this gate before the work described below. It routes every task through
brainstorm → spec → plan → TDD, adapting to how clear the input is. There is
NO human available during this run: act autonomously and record your reasoning
instead of waiting for approval.

If the `superpowers:brainstorming`, `superpowers:writing-plans`, and
`superpowers:test-driven-development` skills are available, invoke them for
fuller guidance. If they are not installed, follow the inline protocol below —
it is self-contained.

## 0. Resolve the task key

- GitHub issue run → task-key = `issue-<issue number>`.
- Plan/PRD run → task-key = a stable slug from the primary plan-file basename
  (e.g. `docs/plans/foo.md` → `foo`). If inputs are inline text, use a short
  kebab-case of the task title.

Spec path: `.otto/specs/<task-key>-design.md`
Plan path: `.otto/plans/<task-key>.md`

## 1. CLARITY GATE

Check whether `.otto/specs/<task-key>-design.md` already exists.

- **Spec exists** → skip brainstorming. Read the spec and
  `.otto/plans/<task-key>.md`, pick the next unchecked task, and go to
  TDD IMPLEMENT (section 3). If every plan task is checked AND the feedback
  loops pass, output `<promise>NO MORE TASKS</promise>`.
- **No spec** → judge the input's clarity. It is UNCLEAR if any of: no
  plan/PRD provided; a vague directive ("make it better"); missing acceptance
  criteria; multiple plausible interpretations; internal contradictions.
  - Clear enough → go straight to TDD IMPLEMENT (section 3). Optionally jot a
    short plan to `.otto/plans/<task-key>.md` first.
  - Unclear → AUTONOMOUS BRAINSTORM (section 2).

## 2. AUTONOMOUS BRAINSTORM (no human in the loop)

Play both sides of a brainstorming session:

1. List the clarifying questions a brainstorming session would ask (purpose,
   scope, constraints, success criteria, edge cases).
2. Answer each one yourself with the most reasonable default given the repo's
   existing patterns. Prefer the simplest viable option (YAGNI).
3. Write `.otto/specs/<task-key>-design.md` containing: Problem, Approach, an
   **Assumptions** section listing each `question → chosen answer → rationale`,
   and Testing notes.
4. Write `.otto/plans/<task-key>.md` as an ordered checklist of bite-sized,
   testable tasks (one `- [ ]` per task).
5. Do NOT wait for approval — the written assumptions are the record.

If a question is genuinely blocking (needs a secret or a human-only decision),
record the blocker in the spec and the commit body, take the safest assumption,
and make forward progress on the unblocked parts. Never stop and wait — this is
AFK.

## 3. TDD IMPLEMENT

Implement exactly one task, test-first:

1. Write a failing test that pins the intended behavior.
2. Run it; confirm it fails for the right reason.
3. Write the minimal code to make it pass.
4. Run the feedback loops described below until green.
5. Update `.otto/plans/<task-key>.md`: check off the task. If a new durable,
   reusable learning emerged, append it to `.otto/LEARNINGS.md`.

Commit the code, the updated spec/plan, and LEARNINGS together in the single
task commit described below — do NOT make separate commits for them.
```

- [ ] **Step 2: Verify the render test now passes (wiring test still fails)**

Run: `pnpm --filter @phamvuhoang/otto-core test -- superpowers-include`
Expected: the "renders the CLARITY GATE marker" test PASSES; the "is included by ... playbooks" test still FAILS (includes not wired yet).

---

## Task 3: Wire the include into `prompt.md`

**Files:**

- Modify: `packages/core/templates/prompt.md` (insert before `# TASK SELECTION`)

- [ ] **Step 1: Add the include directive**

In `packages/core/templates/prompt.md`, find:

```markdown
Work through the plan/PRD tasks. If all of them are complete, output `<promise>NO MORE TASKS</promise>`.

# TASK SELECTION
```

Replace with:

```markdown
Work through the plan/PRD tasks. If all of them are complete, output `<promise>NO MORE TASKS</promise>`.

@include:superpowers.md

# TASK SELECTION
```

---

## Task 4: Wire the include into `ghprompt-workflow.md`

**Files:**

- Modify: `packages/core/templates/ghprompt-workflow.md` (insert at the very top, before `# EXPLORATION`)

- [ ] **Step 1: Add the include directive**

In `packages/core/templates/ghprompt-workflow.md`, find the first line:

```markdown
# EXPLORATION
```

Replace with:

```markdown
@include:superpowers.md

# EXPLORATION
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- superpowers-include`
Expected: BOTH tests PASS.

---

## Task 5: Sync the spec's component table

**Files:**

- Modify: `docs/superpowers/specs/2026-06-14-always-on-superpowers-afk-design.md`

- [ ] **Step 1: Correct the edited-files table**

In the spec's `## Architecture` table, the rows currently list three edited
playbooks (`prompt.md`, `ghprompt.md`, `ghprompt-workflow.md`). Remove the
`ghprompt.md` row and adjust the surrounding prose so it states that
`ghprompt-workflow.md` covers both gh paths (directly for `--issue`,
transitively via `ghprompt.md` for multi-issue), and that editing `ghprompt.md`
too would double-include. The final table lists exactly: `superpowers.md`
(new), `prompt.md` (modify), `ghprompt-workflow.md` (modify).

---

## Task 6: Full verification + commit

- [ ] **Step 1: Run the full verify suite**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: typecheck clean; core vitest green (including the new
`superpowers-include` tests); root `node --test` green.

- [ ] **Step 2: Smoke-render each bin's playbook to eyeball the gate**

Run:

```bash
node -e 'import("./packages/core/dist/render.js").then(m=>{for(const t of ["afk.md","ghafk.md","ghafk-issue.md"]){const o=m.renderTemplate("packages/core/templates/"+t,{INPUTS:"123"});console.log(t, o.includes("CLARITY GATE")?"OK gate present":"MISSING GATE");}})'
```

(Run `pnpm -r build` first if `dist/` is stale.)
Expected: `afk.md OK`, `ghafk.md OK`, `ghafk-issue.md OK` — the gate reaches all three entry points.

- [ ] **Step 3: Commit**

```bash
git add packages/core/templates/superpowers.md \
        packages/core/templates/prompt.md \
        packages/core/templates/ghprompt-workflow.md \
        packages/core/src/__tests__/superpowers-include.test.ts \
        docs/superpowers/specs/2026-06-14-always-on-superpowers-afk-design.md
git commit -m "feat(core): always-on superpowers workflow in AFK playbooks

- New templates/superpowers.md: clarity gate -> autonomous brainstorm -> spec/plan -> TDD
- Included into prompt.md (afk) and ghprompt-workflow.md (both gh paths)
- Artifacts under .otto/specs and .otto/plans, task-keyed, idempotent across iterations"
```

---

## Self-Review

**Spec coverage:**

- Decision 1 (autonomous brainstorm) → fragment §2. ✓
- Decision 2 (agent-judged clarity trigger) → fragment §1. ✓
- Decision 3 (`.otto/` artifacts, task-keyed) → fragment §0, §2. ✓
- Decision 4 (TDD always, loop drives tasks) → fragment §3; no subagent dispatch. ✓
- Approach A (templates-only, shared include) → Tasks 2–4; no code/stage changes. ✓
- Robustness (self-contained, skills optional) → fragment intro paragraph. ✓
- Idempotency (spec/plan committed with work) → fragment §1 spec-exists branch, §3 commit-together; Task 6 commit. ✓
- Testing (render/include tests) → Task 1; smoke per-bin → Task 6 Step 2. ✓

**Placeholder scan:** No TBD/TODO; every code/content step shows full content. ✓

**Type/name consistency:** Marker strings `CLARITY GATE` and `AUTONOMOUS BRAINSTORM` asserted in Task 1 match the headings written in Task 2. Include directive `@include:superpowers.md` is identical across Tasks 1, 3, 4. Filenames consistent throughout. ✓
