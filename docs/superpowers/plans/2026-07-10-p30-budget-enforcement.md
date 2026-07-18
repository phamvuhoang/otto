# P30 Context Budget Enforcement + State Digest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `--token-mode enforce` tier that, when `assessContextBudget` reports a stage's assembled context over budget, degrades it through a governed ladder — tighter `boundLearnings` budget → reversible evidence compression → `compactCommits` — recording every application; retire stale re-derived state into a bounded, harness-written per-run state digest; and bound the `resumeNote` chain. Default runs (no opt-in) stay **byte-for-byte unchanged**.

**Architecture:** A new pure module `context-enforcement.ts` implements the ladder over the rendered prompt string, rewriting only the blocks `analyzeContext` already recognizes (`<learnings>`, evidence tags, `<commits>`) and never `<inputs>`/playbook text; `stage-exec.ts` invokes it between render and spawn (the only place the final prompt exists). Lever (a) runs through a loop-supplied hook that re-renders learnings from governed `.otto/memory/` records (the substrate P29 wires as the `{{ LEARNINGS }}` path — **P30 builds on P29's wired levers**); lever (b) reuses the existing `compressContentSync` seam (P22 #200 anchor-survival floor + retrieval store apply unchanged); lever (c) is self-contained (`parseCommitLog`/`compactCommits`). Each application is a `ContextEnforcementEvent` on the stage record, aggregated on the manifest via the `inputSharpness` optional-field pattern. A new `state-digest.ts` builds a bounded digest from run evidence each iteration; it and the char-bounded resume note ride the existing `RESUME` template var — no template changes. The context report distinguishes **Enforced** (events with measured savings) from **Advisory** (over-budget, lever not pulled).

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥20, vitest. `packages/core` only. No new npm dependencies.

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **No new npm dependencies.**
- **Byte-for-byte default.** With token mode `off`/`measure`/`reduce`, the prompt sent to `runStage` and every record/manifest byte are unchanged. Enforcement and the digest exist only under `enforce`.
- **Never truncate task inputs or policy/safety content.** The ladder can only rewrite `<learnings>`, `<issue>`/`<issues-summary>`/`<issues-full-file>`, and `<commits>` blocks. No other path removes bytes.
- **Every enforcement action is recorded** — including zero-saving applications.
- **P22 gate:** survival fixtures (Tasks 5, 7) must pass in CI for every category enforcement touches; the compress lever additionally inherits the #200 runtime anchor-survival floor. **Dependency note:** #200 (`isCompressibleCategory` + `SURVIVAL_FLOOR`) is on `fix/phase5-review-findings` and P29 wires `boundLearnings`/`{{ LEARNINGS }}`; land both before (or with) Task 4.
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit runs prettier + typecheck.
- **Never hand-edit release version state.** release-please owns it.

---

### Task 1: `enforce` token-mode tier (type + parse + config leg + CLI text)

**Files:**

- Modify: `packages/core/src/tokens.ts` (`TokenMode` at `:1`, `parseTokenMode` at `:118-130`, new `readConfigTokenMode`)
- Modify: `packages/core/src/cli-help.ts` (usage line `:574`)
- Modify: `packages/core/src/run-bin.ts` (token-mode resolution `:169-180`)
- Modify: `packages/core/src/index.ts` (export `readConfigTokenMode` alongside the tokens exports)
- Test: `packages/core/src/__tests__/token-mode-enforce.test.ts`

**Interfaces:**

- Consumes: existing `parseTokenMode(raw, source)` contract; `readCompressorMode`'s typo-safe config-resolution pattern (`context-compressor.ts:139-159`).
- Produces:
  - `export type TokenMode = "off" | "measure" | "reduce" | "enforce";`
  - `parseTokenMode` accepts `"enforce"`; rejection message names `off|measure|reduce|enforce`.
  - `export function readConfigTokenMode(workspaceDir: string): TokenMode` — `.otto/config.json` `"tokenMode"`; absent/malformed/typo ⇒ `"off"` (a typo never silently enables enforcement).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/token-mode-enforce.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTokenMode, readConfigTokenMode } from "../tokens.js";

describe("parseTokenMode enforce tier (P30)", () => {
  it("accepts enforce", () => {
    expect(parseTokenMode("enforce")).toBe("enforce");
  });
  it("keeps the empty default at off", () => {
    expect(parseTokenMode(undefined)).toBe("off");
  });
  it("names all four modes when rejecting", () => {
    expect(() => parseTokenMode("emforce")).toThrow(
      /off\|measure\|reduce\|enforce/
    );
  });
});

describe("readConfigTokenMode (flag > env > config > off, config leg)", () => {
  it("reads tokenMode from .otto/config.json and typo-degrades to off", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-token-mode-"));
    try {
      mkdirSync(join(ws, ".otto"), { recursive: true });
      writeFileSync(
        join(ws, ".otto", "config.json"),
        JSON.stringify({ tokenMode: "enforce" })
      );
      expect(readConfigTokenMode(ws)).toBe("enforce");
      writeFileSync(
        join(ws, ".otto", "config.json"),
        JSON.stringify({ tokenMode: "enfooorce" })
      );
      expect(readConfigTokenMode(ws)).toBe("off");
      expect(readConfigTokenMode(join(ws, "missing"))).toBe("off");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- token-mode-enforce`
Expected: FAIL — `"enforce"` rejected; `readConfigTokenMode` not exported.

- [ ] **Step 3: Implement**

In `tokens.ts` (add `readFileSync`/`join` imports at top):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type TokenMode = "off" | "measure" | "reduce" | "enforce";

export function parseTokenMode(
  raw: string | undefined,
  source = "--token-mode"
): TokenMode {
  const trimmed = raw?.trim();
  if (!trimmed) return "off";
  if (
    trimmed === "off" ||
    trimmed === "measure" ||
    trimmed === "reduce" ||
    trimmed === "enforce"
  ) {
    return trimmed;
  }
  throw new Error(
    `${source} must be one of off|measure|reduce|enforce, got: ${JSON.stringify(raw)}`
  );
}

/**
 * `.otto/config.json` "tokenMode" leg of the flag > env > config > off chain
 * (P30). Absent/malformed config or an unrecognized value resolves to "off",
 * so a typo never silently enables enforcement (mirrors resolveCompressorMode).
 */
export function readConfigTokenMode(workspaceDir: string): TokenMode {
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8")
    ) as Record<string, unknown>;
    if (typeof raw.tokenMode === "string") {
      return parseTokenMode(raw.tokenMode, "config tokenMode");
    }
  } catch {
    // absent/malformed config, or a typo'd value (parse throw) → off
  }
  return "off";
}
```

In `run-bin.ts:169-180`, extend the resolution (flag already handled by `parseFlags`; env stays; config is the new lowest leg — `workspaceDir` is already resolved above at `:144`):

```ts
let tokenMode: TokenMode = flags.tokenMode ?? "off";
let tokenModeError: string | undefined;
if (flags.tokenMode == null) {
  const envRaw = process.env.OTTO_TOKEN_MODE?.trim();
  if (envRaw) {
    try {
      tokenMode = parseTokenMode(envRaw, "OTTO_TOKEN_MODE");
    } catch (err) {
      tokenModeError = (err as Error).message;
    }
  } else {
    tokenMode = readConfigTokenMode(workspaceDir);
  }
}
```

In `cli-help.ts:574`, update the usage line:

```text
  --token-mode <mode> token accounting mode: off | measure | reduce | enforce (default: off; enforce = measure + governed over-budget degrade ladder, P30)
```

Export `readConfigTokenMode` from `index.ts` next to the existing tokens exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- token-mode-enforce`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/tokens.ts packages/core/src/cli-help.ts packages/core/src/run-bin.ts packages/core/src/index.ts packages/core/src/__tests__/token-mode-enforce.test.ts
git commit -m "feat(p30): enforce tier for --token-mode (flag/env/config)"
```

---

### Task 2: `context-enforcement.ts` — the governed degrade ladder (pure)

**Files:**

- Create: `packages/core/src/context-enforcement.ts`
- Modify: `packages/core/src/index.ts` (export the new types + functions)
- Test: `packages/core/src/__tests__/context-enforcement.test.ts`

**Interfaces:**

- Consumes (all existing, unchanged): `assessContextBudget` + `ContextBudgetAssessment` (`context-budget.ts:114`), `analyzeContext` (`context-report.ts:92`), `parseCommitLog`/`compactCommits`/`formatCompactedCommits` (`iteration-compaction.ts:67/93/130`), `DEFAULT_LEARNINGS_BUDGET_CHARS` (`memory.ts:374` — the P29-wired lever's budget baseline), `TokenMode` (Task 1).
- Produces:
  - `export type ContextEnforcementLever = "bound-learnings" | "compress-spill" | "compact-commits";`
  - `export type ContextEnforcementEvent = { lever: ContextEnforcementLever; beforeTokens: number; afterTokens: number; stage: string };`
  - `export const RESUME_NOTE_MAX_CHARS = 2000;` and `export function boundResumeNote(note: string, maxChars?: number): string` — head-preserving, elision marker (the `DEFAULT_SKILLS_BUDGET_CHARS` pattern, `skill-routing.ts:24`).
  - `export type EnforcementHooks = { renderBoundedLearnings?: (budgetChars: number) => string | null; compressEvidence?: (tag: string, text: string) => string | null };`
  - `export function enforceContextBudget(prompt: string, ctx: { stage: string; model?: string; maxTokens?: number; fraction?: number; learningsBudgetChars?: number; commitsBudgetChars?: number; hooks?: EnforcementHooks }): { prompt: string; events: ContextEnforcementEvent[]; assessment: ContextBudgetAssessment }`
  - `export function composeResume(digest: string, note: string, mode: TokenMode): string` — enforce ⇒ `digest + bounded note`; other modes ⇒ `note` verbatim (byte-for-byte default).
  - `export type EnforcementSummary = { applications: number; tokensSaved: number; byLever: Partial<Record<ContextEnforcementLever, number>> };` and `export function summarizeEnforcement(events: ContextEnforcementEvent[]): EnforcementSummary`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/context-enforcement.test.ts
import { describe, expect, it } from "vitest";
import {
  boundResumeNote,
  enforceContextBudget,
  RESUME_NOTE_MAX_CHARS,
  summarizeEnforcement,
  type EnforcementHooks,
} from "../context-enforcement.js";

const LONG_BODY = "Investigated the flaky retry loop in detail. ".repeat(20);
const commitEntry = (n: number): string =>
  `${"a".repeat(39)}${n}\n2026-07-0${n}\nfeat: step ${n}\n\n${LONG_BODY}\n---`;
const INPUTS_BLOCK = "<inputs>fix the E_TIMEOUT_42 retry bug</inputs>";
const PLAYBOOK = "workflow playbook: implement, verify, commit.";
const PROMPT = [
  "<commits>",
  [3, 2, 1].map(commitEntry).join("\n"),
  "</commits>",
  "<learnings>",
  `# Otto learnings\n${"- always run pnpm -r typecheck before commit\n".repeat(80)}`,
  "</learnings>",
  "<issue>",
  `Error E_TIMEOUT_42 in src/net/client.ts v1.2.3\n${"reporter noise. ".repeat(400)}`,
  "</issue>",
  INPUTS_BLOCK,
  PLAYBOOK,
].join("\n");

const hooks: EnforcementHooks = {
  renderBoundedLearnings: () => "- always run pnpm -r typecheck before commit",
  compressEvidence: (_tag, text) => text.slice(0, 80),
};

describe("enforceContextBudget ladder (P30)", () => {
  it("applies levers in order and stops once under budget", () => {
    const r = enforceContextBudget(PROMPT, {
      stage: "implementer",
      maxTokens: 1200,
      hooks,
    });
    expect(r.events.map((e) => e.lever)).toEqual([
      "bound-learnings",
      "compress-spill",
    ]);
    expect(r.assessment.overBudget).toBe(false);
    for (const e of r.events) {
      expect(e.stage).toBe("implementer");
      expect(e.afterTokens).toBeLessThan(e.beforeTokens);
    }
  });

  it("never touches the inputs block or playbook text", () => {
    const r = enforceContextBudget(PROMPT, {
      stage: "implementer",
      maxTokens: 100,
      hooks,
    });
    expect(r.prompt).toContain(INPUTS_BLOCK);
    expect(r.prompt).toContain(PLAYBOOK);
  });

  it("falls through to compact-commits and reports exhaustion honestly", () => {
    const r = enforceContextBudget(PROMPT, {
      stage: "reviewer",
      maxTokens: 100, // unreachable: levers exhaust, still over budget
    });
    expect(r.events.map((e) => e.lever)).toEqual(["compact-commits"]);
    expect(r.prompt).toContain("_Compacted:");
    expect(r.assessment.overBudget).toBe(true);
  });

  it("skips the learnings lever when the hook cannot re-derive (null)", () => {
    const r = enforceContextBudget(PROMPT, {
      stage: "implementer",
      maxTokens: 100,
      hooks: { renderBoundedLearnings: () => null },
    });
    expect(r.events.some((e) => e.lever === "bound-learnings")).toBe(false);
    expect(r.prompt).toContain(
      "- always run pnpm -r typecheck before commit\n"
    );
  });

  it("does nothing when already within budget", () => {
    const r = enforceContextBudget(PROMPT, {
      stage: "implementer",
      maxTokens: 1_000_000,
      hooks,
    });
    expect(r.events).toEqual([]);
    expect(r.prompt).toBe(PROMPT);
  });
});

describe("boundResumeNote", () => {
  it("leaves short notes untouched", () => {
    expect(boundResumeNote("short note")).toBe("short note");
  });
  it("head-preserves long notes with an elision marker under the cap", () => {
    const long = "resume ".repeat(1000);
    const bounded = boundResumeNote(long);
    expect(bounded.length).toBeLessThanOrEqual(RESUME_NOTE_MAX_CHARS);
    expect(bounded.startsWith("resume resume")).toBe(true);
    expect(bounded).toMatch(/chars elided/);
  });
});

describe("summarizeEnforcement", () => {
  it("aggregates applications, savings, and per-lever counts", () => {
    const s = summarizeEnforcement([
      {
        lever: "bound-learnings",
        beforeTokens: 900,
        afterTokens: 500,
        stage: "a",
      },
      {
        lever: "compress-spill",
        beforeTokens: 500,
        afterTokens: 300,
        stage: "a",
      },
      {
        lever: "compress-spill",
        beforeTokens: 300,
        afterTokens: 300,
        stage: "b",
      },
    ]);
    expect(s).toEqual({
      applications: 3,
      tokensSaved: 600,
      byLever: { "bound-learnings": 1, "compress-spill": 2 },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- context-enforcement`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// packages/core/src/context-enforcement.ts
/**
 * Context budget enforcement ladder (Phase 6 P30). `assessContextBudget` (P7)
 * measures and recommends but is "Soft, not a gate … Pure + INERT on the loop"
 * (context-budget.ts:12-16); this module is the gate it anticipated. Under
 * `--token-mode enforce`, an over-budget rendered prompt degrades through
 * governed levers IN ORDER — (a) tighter boundLearnings budget (the P29-wired
 * lever, halved), (b) reversible compression of retrievable evidence blocks
 * via the existing compressor seam (P22 #200 anchor-survival floor applies
 * inside compressContentSync), (c) compactCommits on the commits block —
 * re-assessing between rungs and stopping once under budget. Every
 * application is recorded as a ContextEnforcementEvent, zero-saving ones
 * included. The `<inputs>` task source and playbook/policy text are
 * structurally unreachable: only the three recognized block families are ever
 * rewritten. Pure — lever side effects (memory reads, compressor subprocess,
 * retrieval-store writes) live behind injected hooks.
 */
import {
  assessContextBudget,
  type ContextBudgetAssessment,
} from "./context-budget.js";
import { analyzeContext } from "./context-report.js";
import {
  compactCommits,
  formatCompactedCommits,
  parseCommitLog,
} from "./iteration-compaction.js";
import { DEFAULT_LEARNINGS_BUDGET_CHARS } from "./memory.js";
import type { TokenMode } from "./tokens.js";

export type ContextEnforcementLever =
  | "bound-learnings"
  | "compress-spill"
  | "compact-commits";

/** One recorded ladder application: whole-prompt estimated tokens before/after. */
export type ContextEnforcementEvent = {
  lever: ContextEnforcementLever;
  beforeTokens: number;
  afterTokens: number;
  stage: string;
};

/**
 * Char cap for the accretive resumeNote chain (loop.ts:975/1036/1385),
 * matching the skills block's budget pattern (DEFAULT_SKILLS_BUDGET_CHARS,
 * skill-routing.ts:24). Applied only in enforce mode (composeResume), so
 * default runs stay byte-for-byte.
 */
export const RESUME_NOTE_MAX_CHARS = 2000;

/** Head-preserving truncation with an elision marker; ≤ maxChars total. */
export function boundResumeNote(
  note: string,
  maxChars = RESUME_NOTE_MAX_CHARS
): string {
  if (note.length <= maxChars) return note;
  const head = note.slice(0, Math.max(0, maxChars - 48));
  return `${head}\n… [bounded: ${note.length - head.length} chars elided]`;
}

/**
 * Compose the RESUME template var (P30). Enforce mode: the harness state
 * digest (state-digest.ts, Task 5) rides in front of the char-bounded note;
 * every other mode returns the note verbatim.
 */
export function composeResume(
  digest: string,
  note: string,
  mode: TokenMode
): string {
  if (mode !== "enforce") return note;
  return [digest, boundResumeNote(note)].filter((s) => s !== "").join("\n\n");
}

/**
 * Injected lever implementations. `renderBoundedLearnings` re-renders the
 * learnings block from governed .otto/memory records at a tighter char budget
 * (null = cannot re-derive — the block is then left alone, never blindly
 * cut). `compressEvidence` compresses one retrievable evidence block through
 * the existing compressor (null = compressor off/unavailable/kept original).
 */
export type EnforcementHooks = {
  renderBoundedLearnings?: (budgetChars: number) => string | null;
  compressEvidence?: (tag: string, text: string) => string | null;
};

export type EnforcementContext = {
  stage: string;
  /** Model spec — selects the window (assessContextBudget). */
  model?: string;
  /** Explicit token ceiling override (tests, future config). */
  maxTokens?: number;
  /** Fraction of the window; default 0.25 (context-budget.ts:44). */
  fraction?: number;
  /** Active learnings budget to halve; default DEFAULT_LEARNINGS_BUDGET_CHARS
   *  (P29's wired budget when it lands). */
  learningsBudgetChars?: number;
  /** Commits budget for lever (c); default DEFAULT_COMMITS_BUDGET_CHARS. */
  commitsBudgetChars?: number;
  hooks?: EnforcementHooks;
};

export type EnforcementResult = {
  prompt: string;
  events: ContextEnforcementEvent[];
  /** Final post-ladder assessment (initial one when no lever applied). */
  assessment: ContextBudgetAssessment;
};

/** The retrievable evidence tags analyzeContext maps to `evidence`
 *  (context-report.ts:58-69) — re-fetchable from the tracker, so compressible
 *  under the #200 floor. */
const EVIDENCE_TAGS = ["issue", "issues-summary", "issues-full-file"] as const;

function blockBody(prompt: string, tag: string): string | null {
  const m = prompt.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

function replaceBlock(prompt: string, tag: string, body: string): string {
  return prompt.replace(
    new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`),
    () => `<${tag}>\n${body}\n</${tag}>`
  );
}

/** Apply the P30 degrade ladder to one rendered prompt. Pure given hooks. */
export function enforceContextBudget(
  prompt: string,
  ctx: EnforcementContext
): EnforcementResult {
  const budget = {
    model: ctx.model,
    maxTokens: ctx.maxTokens,
    fraction: ctx.fraction,
  };
  const events: ContextEnforcementEvent[] = [];
  let current = prompt;
  let assessment = assessContextBudget(analyzeContext(current), budget);

  const apply = (lever: ContextEnforcementLever, next: string): void => {
    const beforeTokens = assessment.estimatedTokens;
    current = next;
    assessment = assessContextBudget(analyzeContext(current), budget);
    events.push({
      lever,
      beforeTokens,
      afterTokens: assessment.estimatedTokens,
      stage: ctx.stage,
    });
  };

  // (a) tighter bounded-learnings budget (halved) — only via the re-derive
  // hook (P29 substrate); a block that cannot be re-derived is never cut.
  if (assessment.overBudget && ctx.hooks?.renderBoundedLearnings) {
    const body = blockBody(current, "learnings");
    if (body !== null) {
      const halved = Math.floor(
        (ctx.learningsBudgetChars ?? DEFAULT_LEARNINGS_BUDGET_CHARS) / 2
      );
      const bounded = ctx.hooks.renderBoundedLearnings(halved);
      if (bounded !== null && bounded.length < body.length) {
        apply("bound-learnings", replaceBlock(current, "learnings", bounded));
      }
    }
  }

  // (b) reversible compression of retrievable evidence blocks via the
  // existing compressor seam (anchor-survival floor + retrieval store inside).
  if (assessment.overBudget && ctx.hooks?.compressEvidence) {
    for (const tag of EVIDENCE_TAGS) {
      if (!assessment.overBudget) break;
      const body = blockBody(current, tag);
      if (body === null || body.trim() === "") continue;
      const compressed = ctx.hooks.compressEvidence(tag, body);
      if (compressed !== null && compressed.length < body.length) {
        apply("compress-spill", replaceBlock(current, tag, compressed));
      }
    }
  }

  // (c) compact the commits block: newest kept in full, older degraded to
  // subject-only with the honest "_Compacted:_" note (iteration-compaction).
  if (assessment.overBudget) {
    const body = blockBody(current, "commits");
    if (body !== null) {
      const compacted = compactCommits(parseCommitLog(body), {
        maxChars: ctx.commitsBudgetChars,
      });
      if (compacted.compacted.length > 0) {
        apply(
          "compact-commits",
          replaceBlock(current, "commits", formatCompactedCommits(compacted))
        );
      }
    }
  }

  return { prompt: current, events, assessment };
}

/** Manifest-level rollup of a run's enforcement events (inputSharpness pattern). */
export type EnforcementSummary = {
  applications: number;
  tokensSaved: number;
  byLever: Partial<Record<ContextEnforcementLever, number>>;
};

export function summarizeEnforcement(
  events: ContextEnforcementEvent[]
): EnforcementSummary {
  const byLever: EnforcementSummary["byLever"] = {};
  let tokensSaved = 0;
  for (const e of events) {
    byLever[e.lever] = (byLever[e.lever] ?? 0) + 1;
    tokensSaved += Math.max(0, e.beforeTokens - e.afterTokens);
  }
  return { applications: events.length, tokensSaved, byLever };
}
```

Export from `index.ts`: `boundResumeNote`, `composeResume`, `enforceContextBudget`, `summarizeEnforcement`, `RESUME_NOTE_MAX_CHARS`, and the types `ContextEnforcementLever`, `ContextEnforcementEvent`, `EnforcementHooks`, `EnforcementSummary`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- context-enforcement`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/context-enforcement.ts packages/core/src/index.ts packages/core/src/__tests__/context-enforcement.test.ts
git commit -m "feat(p30): governed context-budget degrade ladder + resume-note bound (pure)"
```

---

### Task 3: Enforcement point in `stage-exec.ts` + evidence fields

**Files:**

- Modify: `packages/core/src/stage-exec.ts` (the render→spawn region `:153-209`)
- Modify: `packages/core/src/runner.ts` (`StageResult` at `:44-73`)
- Modify: `packages/core/src/run-report.ts` (`StageRecord` at `:114-142`, `RunManifest` at `:150-191`)
- Test: `packages/core/src/__tests__/p30-stage-exec-enforce.test.ts`

**Interfaces:**

- Consumes: `enforceContextBudget` + `EnforcementHooks` + `ContextEnforcementEvent` (Task 2); `assessContextBudget`/`ContextBudgetAssessment`; existing `compressContentSync` (`context-compressor.ts:306`), `compressionToolUsage` (`:351`), `analyzeContext`, `applyPromptReduction`, `resolveStageModel`.
- Produces:
  - `ExecuteStageOptions` gains `renderBoundedLearnings?: (budgetChars: number) => string | null;` (loop-supplied lever-a hook) and `budgetMaxTokens?: number;` (explicit ceiling; unset ⇒ model-derived).
  - `StageResult` gains `contextBudget?: ContextBudgetAssessment;` and `contextEnforcement?: ContextEnforcementEvent[];` (import types from `./context-budget.js` / `./context-enforcement.js`).
  - `StageRecord` gains the same two optional fields; `RunManifest` gains `contextEnforcement?: EnforcementSummary;` (populated in Task 4).

- [ ] **Step 1: Write the failing test** (mirrors the existing `stage-exec.test.ts` mocked-runner pattern)

```ts
// packages/core/src/__tests__/p30-stage-exec-enforce.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "../stages.js";
import { emptyTokenUsage } from "../tokens.js";

const mocks = vi.hoisted(() => ({ runStage: vi.fn() }));
vi.mock("../runner.js", () => ({
  runStage: mocks.runStage,
  getAgentRuntime: (id: string) => ({ id }),
  stageLogPath: (ws: string, i: number, s: string, r?: string) =>
    `${ws}/.otto-tmp/logs/iter${i}-${s}${r ? `-${r}` : ""}.ndjson`,
}));

import { executeStage } from "../stage-exec.js";

const stage: Stage = { name: "implementer", template: "stage.md" };
const ok = {
  result: "done",
  costUsd: 0,
  isError: false,
  apiErrorStatus: null,
  usage: emptyTokenUsage(),
  runtimeId: "claude" as const,
};

const TEMPLATE = [
  "<commits>",
  `${"a".repeat(40)}\n2026-07-01\nfeat: one\n\n${"long body. ".repeat(200)}\n---`,
  "</commits>",
  "<learnings>",
  `${"- learned thing\n".repeat(400)}`,
  "</learnings>",
  "<inputs>{{ INPUTS }}</inputs>",
  "playbook tail.",
].join("\n");

describe("executeStage enforce mode (P30)", () => {
  let root: string;
  let workspaceDir: string;
  let packageDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "otto-p30-exec-"));
    workspaceDir = join(root, "workspace");
    packageDir = join(root, "pkg");
    mkdirSync(join(packageDir, "templates"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(packageDir, "templates", stage.template), TEMPLATE);
    mocks.runStage.mockReset().mockResolvedValue(ok);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const base = () => ({
    stage,
    vars: { INPUTS: "fix issue-142" },
    workspaceDir,
    packageDir,
    iteration: 1,
    maxRetries: 0,
  });

  it("measure mode attaches the budget assessment without changing the prompt", async () => {
    const r = await executeStage({
      ...base(),
      tokenMode: "measure",
      budgetMaxTokens: 100,
    });
    expect(r.contextBudget?.overBudget).toBe(true);
    expect(r.contextEnforcement).toBeUndefined();
    expect(mocks.runStage.mock.calls[0][1]).toContain("- learned thing\n");
  });

  it("enforce mode runs the ladder, records events, and never touches inputs", async () => {
    const r = await executeStage({
      ...base(),
      tokenMode: "enforce",
      budgetMaxTokens: 100,
      renderBoundedLearnings: () => "- learned thing (bounded)",
    });
    const sent = mocks.runStage.mock.calls[0][1] as string;
    expect(sent).toContain("- learned thing (bounded)");
    expect(sent).toContain("_Compacted:");
    expect(sent).toContain("<inputs>fix issue-142</inputs>");
    const levers = (r.contextEnforcement ?? []).map((e) => e.lever);
    expect(levers).toEqual(["bound-learnings", "compact-commits"]);
    expect(r.contextBudget).toBeDefined();
  });

  it("off mode attaches neither field and sends the prompt verbatim", async () => {
    const r = await executeStage({ ...base(), tokenMode: "off" });
    expect(r.contextBudget).toBeUndefined();
    expect(r.contextEnforcement).toBeUndefined();
    expect(mocks.runStage.mock.calls[0][1]).toContain("- learned thing\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- p30-stage-exec-enforce`
Expected: FAIL — `budgetMaxTokens`/`renderBoundedLearnings` unknown; no `contextBudget` on the result.

- [ ] **Step 3: Implement**

`runner.ts` — extend `StageResult` (after `contextBreakdown` at `:59`):

```ts
  /** Budget assessment of the final prompt (P30; measure + enforce). */
  contextBudget?: import("./context-budget.js").ContextBudgetAssessment;
  /** Ladder applications when enforce mode acted (P30); absent = none. */
  contextEnforcement?: import("./context-enforcement.js").ContextEnforcementEvent[];
```

`run-report.ts` — same two optional fields on `StageRecord` (after `contextBreakdown` at `:131`), and on `RunManifest` (after `inputSharpness` at `:182`):

```ts
  /** Aggregated P30 enforcement outcome; absent when no lever fired. */
  contextEnforcement?: import("./context-enforcement.js").EnforcementSummary;
```

`stage-exec.ts` — add to `ExecuteStageOptions`:

```ts
  /** P30 lever (a): re-render the learnings block from governed memory records
   *  at a tighter budget; null = cannot re-derive (lever skipped). */
  renderBoundedLearnings?: (budgetChars: number) => string | null;
  /** Explicit budget ceiling for the P30 assessment (unset ⇒ model-derived). */
  budgetMaxTokens?: number;
```

Then rework the region between `renderTemplate` and `runStage` (`:165-209`). The model resolution moves **above** enforcement (the budget needs the window); reduce's whitespace compaction also runs under enforce (free + safe):

```ts
if (tokenMode === "reduce" || tokenMode === "enforce") {
  const reduced = applyPromptReduction(prompt);
  prompt = reduced.prompt;
  const { originalChars, reducedChars, cacheHits } = reduced.stats;
  process.stderr.write(
    `${dim(`prompt reduce ${originalChars} -> ${reducedChars} chars | cache hits ${cacheHits}`)}\n`
  );
}
if (opts.injectedContext && opts.injectedContext.trim().length > 0) {
  prompt = `${prompt}\n\n${opts.injectedContext}\n`;
}
// Route the model for this stage (issue #66 P11) — resolved before
// enforcement so the P30 budget can use the routed model's window.
const model = resolveStageModel({
  runtimeId: opts.agentId ?? DEFAULT_AGENT,
  stage,
  routing: opts.modelRouting === true,
  ladder: opts.tierLadder ?? EMPTY_LADDER,
  assessment: opts.riskAssessment,
  escalations: opts.escalations,
});
// P30: assess the final prompt against the soft budget (measure+enforce);
// in enforce mode, degrade an over-budget prompt through the governed
// ladder. Off/reduce: nothing here runs — byte-for-byte today.
let contextBudget: ContextBudgetAssessment | undefined;
let contextEnforcement: ContextEnforcementEvent[] | undefined;
if (tokenMode === "measure" || tokenMode === "enforce") {
  contextBudget = assessContextBudget(analyzeContext(prompt), {
    model: model.spec,
    maxTokens: opts.budgetMaxTokens,
  });
}
if (tokenMode === "enforce" && contextBudget?.overBudget) {
  const compressEvidence =
    opts.compressor && opts.retrievalStore
      ? (tag: string, text: string): string | null => {
          const out = compressContentSync(
            opts.compressor!,
            {
              key: `${iteration}-${label}-enforce-${tag}`,
              category: "issue-body",
              text,
            },
            opts.retrievalStore ?? null
          );
          if (out.degraded || out.tokensSaved <= 0) return null;
          toolsUsed.push(compressionToolUsage(out, "issue-body", stage.name));
          return out.text;
        }
      : undefined;
  const enforced = enforceContextBudget(prompt, {
    stage: stage.name,
    model: model.spec,
    maxTokens: opts.budgetMaxTokens,
    hooks: {
      ...(opts.renderBoundedLearnings
        ? { renderBoundedLearnings: opts.renderBoundedLearnings }
        : {}),
      ...(compressEvidence ? { compressEvidence } : {}),
    },
  });
  prompt = enforced.prompt;
  contextBudget = enforced.assessment;
  if (enforced.events.length > 0) contextEnforcement = enforced.events;
}
```

Add to the returned spread (next to the existing `toolsUsed` spread at `:220`):

```ts
        ...(contextBudget ? { contextBudget } : {}),
        ...(contextEnforcement ? { contextEnforcement } : {}),
```

New imports in `stage-exec.ts`: `assessContextBudget`, `type ContextBudgetAssessment` from `./context-budget.js`; `enforceContextBudget`, `type ContextEnforcementEvent` from `./context-enforcement.js`.

- [ ] **Step 4: Run tests to verify they pass (including the untouched existing suite)**

Run: `pnpm --filter @phamvuhoang/otto-core test -- p30-stage-exec-enforce`
Expected: PASS (3 tests).
Run: `pnpm --filter @phamvuhoang/otto-core test -- stage-exec`
Expected: PASS — the pre-existing off/measure/reduce tests are untouched and still green (byte-for-byte criterion).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/stage-exec.ts packages/core/src/runner.ts packages/core/src/run-report.ts packages/core/src/__tests__/p30-stage-exec-enforce.test.ts
git commit -m "feat(p30): enforcement point in stage-exec + stage/manifest evidence fields"
```

---

### Task 4: Loop wiring — learnings hook, manifest aggregation, bounded RESUME

**Files:**

- Modify: `packages/core/src/loop.ts` (recordStage `:561-606`, finalizeManifest `:771-` both manifest objects, RESUME sites `:1261`/`:1470`, panel `:1233`, main executeStage call `:1257-1279`)
- Test: `packages/core/src/__tests__/p30-resume-compose.test.ts`

**Interfaces:**

- Consumes: `composeResume`, `summarizeEnforcement`, `boundResumeNote`, `type ContextEnforcementEvent` (Task 2); **the P29-wired lever substrate:** `readMemoryRecords` (`memory.ts:529`), `boundLearnings` (`:443`), `formatBoundedLearnings` (`:471`).
- Produces: no new exports — loop-internal wiring. The `RunManifest.contextEnforcement` field (Task 3) is populated here.

- [ ] **Step 1: Write the failing test** (the composition seam is pure; loop wiring is covered by typecheck + the existing loop suite)

```ts
// packages/core/src/__tests__/p30-resume-compose.test.ts
import { describe, expect, it } from "vitest";
import {
  composeResume,
  RESUME_NOTE_MAX_CHARS,
} from "../context-enforcement.js";

describe("composeResume (P30 RESUME var composition)", () => {
  const longNote = "reconcile against git history. ".repeat(200);

  it("returns the raw note verbatim outside enforce mode (byte-for-byte)", () => {
    expect(
      composeResume("<state-digest>…</state-digest>", longNote, "measure")
    ).toBe(longNote);
    expect(composeResume("", longNote, "off")).toBe(longNote);
  });

  it("bounds the note and prepends the digest under enforce", () => {
    const digest =
      "<state-digest>run r1: iteration 2 of 5 complete.</state-digest>";
    const composed = composeResume(digest, longNote, "enforce");
    expect(composed.startsWith(digest)).toBe(true);
    expect(composed.length).toBeLessThanOrEqual(
      digest.length + 2 + RESUME_NOTE_MAX_CHARS
    );
    expect(composed).toMatch(/chars elided/);
  });

  it("collapses cleanly when the digest is empty", () => {
    expect(composeResume("", "short", "enforce")).toBe("short");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- p30-resume-compose`
Expected: FAIL if `composeResume` behavior diverges (it was implemented in Task 2 — this locks the loop-facing contract; if already green, proceed to Step 3, which is the real wiring).

- [ ] **Step 3: Wire the loop**

Extend the `loop.ts` import block:

```ts
import {
  composeResume,
  summarizeEnforcement,
  type ContextEnforcementEvent,
} from "./context-enforcement.js";
import {
  boundLearnings,
  formatBoundedLearnings,
  readMemoryRecords,
} from "./memory.js";
```

Near `runSkillsUsed` (`:615`), add the run-level accumulator and the digest slot (filled in Task 5):

```ts
/** P30: every ladder application this run, aggregated onto the manifest. */
const runEnforcement: ContextEnforcementEvent[] = [];
/** P30: harness state digest for later iterations (Task 5); enforce-only. */
let stateDigest = "";
```

In `recordStage` (`:584-600`), thread the new evidence and accumulate:

```ts
          ...(sr.contextBudget ? { contextBudget: sr.contextBudget } : {}),
          ...(sr.contextEnforcement
            ? { contextEnforcement: sr.contextEnforcement }
            : {}),
```

and just before the `try`:

```ts
if (sr.contextEnforcement) runEnforcement.push(...sr.contextEnforcement);
```

P30 lever (a) hook — the governed re-derive path (`.otto/memory/` records through the P29-wired `boundLearnings`); place next to the `injectSkills` setup (`:616`):

```ts
// P30 lever (a): re-render the learnings block at a tighter budget from
// governed .otto/memory records. null when no records exist — a legacy
// cat-injected LEARNINGS.md that cannot be re-derived is never blindly cut.
const renderBoundedLearnings =
  tokenMode === "enforce"
    ? (budgetChars: number): string | null => {
        const records = readMemoryRecords(workspaceDir);
        if (records.length === 0) return null;
        return formatBoundedLearnings(
          boundLearnings(records, { maxChars: budgetChars })
        );
      }
    : undefined;
```

Pass it into the main `executeStage` call (`:1257-1279`), alongside `compressor`/`retrievalStore`:

```ts
            renderBoundedLearnings,
```

RESUME composition — replace the three injection sites:

- `:1261` → `RESUME: composeResume(stateDigest, resumeNote, tokenMode),`
- `:1470` (report-rewrite vars) → `RESUME: composeResume(stateDigest, resumeNote, tokenMode),`
- `:1233` (panel) → `resumeNote: composeResume(stateDigest, resumeNote, tokenMode),`

Manifest aggregation — in `finalizeManifest`, add to **both** manifest object literals (the `manifestForReport` at `:836-865` and the `writeManifest` call at `:874-`), next to the `inputSharpness` spread:

```ts
        ...(runEnforcement.length > 0
          ? { contextEnforcement: summarizeEnforcement(runEnforcement) }
          : {}),
```

- [ ] **Step 4: Run tests to verify green**

Run: `pnpm --filter @phamvuhoang/otto-core test -- p30-resume-compose`
Expected: PASS (3 tests).
Run: `pnpm --filter @phamvuhoang/otto-core test`
Expected: full core suite PASS — no existing loop/panel test changes needed (default paths compose to the verbatim note).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/loop.ts packages/core/src/__tests__/p30-resume-compose.test.ts
git commit -m "feat(p30): wire enforcement hooks, manifest rollup, bounded RESUME chain"
```

---

### Task 5: Per-run state digest (the P22 retirement slice)

**Files:**

- Create: `packages/core/src/state-digest.ts`
- Modify: `packages/core/src/loop.ts` (end of the per-iteration body: after the stage `for` loop completes, before the cooldown/persist bookkeeping for the next iteration)
- Modify: `packages/core/src/index.ts` (export `buildStateDigest`, `commitSubjectsSince`, `STATE_DIGEST_MAX_CHARS`)
- Test: `packages/core/src/__tests__/state-digest.test.ts`

**Interfaces:**

- Consumes: `StageRecord`/`RunManifest` types (`run-report.ts:114/150`), `runReportDir` + `readStageRecords` (`run-report.ts`), `boundResumeNote` (Task 2), `assessFactSurvival` (`compression-survival.ts:42` — the P22 gate, test-side).
- Produces:
  - `export const STATE_DIGEST_MAX_CHARS = 2000;`
  - `export type StateDigestInput = { runId: string; inputs: string; iteration: number; totalIterations: number; commitSubjects: string[]; stages: StageRecord[]; verification?: RunManifest["verification"] };`
  - `export function buildStateDigest(input: StateDigestInput, opts?: { maxChars?: number }): string` — pure, bounded, cites run-bundle evidence paths.
  - `export function commitSubjectsSince(workspaceDir: string, sinceSha: string | null): string[]` — `git log --format=%s <sha>..HEAD`, never throws.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/state-digest.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assessFactSurvival } from "../compression-survival.js";
import {
  buildStateDigest,
  commitSubjectsSince,
  STATE_DIGEST_MAX_CHARS,
} from "../state-digest.js";
import { emptyTokenUsage } from "../tokens.js";
import type { StageRecord } from "../run-report.js";

const rec = (
  iteration: number,
  stage: string,
  extra: Partial<StageRecord> = {}
): StageRecord => ({
  iteration,
  stage,
  runtimeId: "claude",
  costUsd: 0,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-07-10T00:00:00Z",
  finishedAt: "2026-07-10T00:01:00Z",
  ...extra,
});

describe("buildStateDigest (P30 — P22 retirement slice)", () => {
  const input = {
    runId: "run-1",
    inputs: "implement issue-142: bounded retries in src/net/client.ts",
    iteration: 3,
    totalIterations: 8,
    commitSubjects: [
      "feat(net): bounded retry backoff",
      "test(net): retry cap",
    ],
    stages: [
      rec(1, "implementer"),
      rec(2, "reviewer", {
        reviewSeverity: {
          blocker: 1,
          major: 2,
          minor: 0,
          nit: 3,
          suppressed: 1,
        },
      }),
      rec(3, "implementer"),
    ],
  };

  it("is bounded and survives its load-bearing facts (P22 gate)", () => {
    const digest = buildStateDigest(input);
    expect(digest.length).toBeLessThanOrEqual(STATE_DIGEST_MAX_CHARS);
    const survival = assessFactSurvival(
      ["issue-142", "src/net/client.ts", "bounded retry backoff", "1 blocker"],
      digest
    );
    expect(survival.survivalRate).toBe(1);
  });

  it("cites the run-bundle evidence path instead of inlining evidence", () => {
    const digest = buildStateDigest(input);
    expect(digest).toContain(".otto/runs/run-1/");
    expect(digest).toContain("iteration 3 of 8");
  });

  it("degrades cleanly with no commits and no findings", () => {
    const digest = buildStateDigest({
      ...input,
      commitSubjects: [],
      stages: [rec(1, "implementer")],
    });
    expect(digest).toContain("no commits yet");
    expect(digest).not.toContain("Open findings");
  });
});

describe("commitSubjectsSince", () => {
  it("lists subjects newest-first from a real repo and never throws", () => {
    const repo = mkdtempSync(join(tmpdir(), "otto-digest-git-"));
    try {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
          { cwd: repo, encoding: "utf8" }
        );
      git("init");
      writeFileSync(join(repo, "a.txt"), "1");
      git("add", "a.txt");
      git("commit", "-m", "base");
      const base = git("rev-parse", "HEAD").trim();
      writeFileSync(join(repo, "a.txt"), "2");
      git("add", "a.txt");
      git("commit", "-m", "feat: add retry");
      expect(commitSubjectsSince(repo, base)).toEqual(["feat: add retry"]);
      expect(commitSubjectsSince(repo, null)).toEqual([]);
      expect(commitSubjectsSince(join(repo, "missing"), base)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- state-digest`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module + loop write/injection**

```ts
// packages/core/src/state-digest.ts
/**
 * Per-run state digest (P30 — the P22 retirement slice). Later iterations
 * today re-derive prior state from scratch (full LEARNINGS.md + commits block
 * per stage); P22 showed most of that late-run context is stale evidence.
 * This digest is the compact replacement: harness-written from run evidence
 * (never agent prose), bounded, and pointing at the run bundle for the
 * originals — retrieval beats re-derivation. Injected via the RESUME var in
 * enforce mode only (composeResume); default runs never see it.
 */
import { execFileSync } from "node:child_process";

import { boundResumeNote } from "./context-enforcement.js";
import type { RunManifest, StageRecord } from "./run-report.js";

export const STATE_DIGEST_MAX_CHARS = 2000;

export type StateDigestInput = {
  runId: string;
  inputs: string;
  /** The just-completed iteration. */
  iteration: number;
  totalIterations: number;
  /** Subjects of commits made since the run started, newest first. */
  commitSubjects: string[];
  /** Stage records so far — findings + evidence come from here. */
  stages: StageRecord[];
  /** Last verification matrix when a --verify stage produced one (P24 today;
   *  P27 attested checks when they land). */
  verification?: RunManifest["verification"];
};

/** Build the bounded digest. Pure. */
export function buildStateDigest(
  input: StateDigestInput,
  opts: { maxChars?: number } = {}
): string {
  const maxChars = opts.maxChars ?? STATE_DIGEST_MAX_CHARS;
  const lines: string[] = [
    "<state-digest>",
    `Run ${input.runId}: iteration ${input.iteration} of ${input.totalIterations} complete.`,
    `Focus: ${input.inputs.slice(0, 240) || "(no inputs)"}`,
  ];
  if (input.commitSubjects.length > 0) {
    lines.push("Done (commits this run, newest first):");
    for (const s of input.commitSubjects.slice(0, 10)) lines.push(`- ${s}`);
  } else {
    lines.push("Done: no commits yet this run.");
  }
  const lastReview = [...input.stages]
    .reverse()
    .find((s) => s.reviewSeverity != null);
  if (lastReview?.reviewSeverity) {
    const r = lastReview.reviewSeverity;
    lines.push(
      `Open findings (iter${lastReview.iteration} review): ` +
        `${r.blocker} blocker / ${r.major} major / ${r.minor} minor.`
    );
  }
  if (input.verification && input.verification.length > 0) {
    const passes = input.verification.filter((v) => v.result === "pass").length;
    lines.push(
      `Checks: ${passes}/${input.verification.length} verification rows passing (last matrix).`
    );
  }
  lines.push(
    `Evidence: full logs and compressed originals under .otto/runs/${input.runId}/ ` +
      "(per-stage NDJSON via each record's logPath; originals under compressed/). " +
      "Retrieve from there instead of re-deriving history.",
    "</state-digest>"
  );
  return boundResumeNote(lines.join("\n"), maxChars);
}

/** Commit subjects since a SHA, newest first. Absent repo/SHA → []. Never throws. */
export function commitSubjectsSince(
  workspaceDir: string,
  sinceSha: string | null
): string[] {
  if (!sinceSha) return [];
  try {
    return execFileSync("git", ["log", "--format=%s", `${sinceSha}..HEAD`], {
      cwd: workspaceDir,
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  } catch {
    return [];
  }
}
```

Loop wiring (`loop.ts`) — imports:

```ts
import { buildStateDigest, commitSubjectsSince } from "./state-digest.js";
import { runReportDir } from "./run-report.js"; // extend the existing run-report import
```

At the end of the per-iteration body in `runLoop` (after the stage `for` loop completes for iteration `i`, next to the existing end-of-iteration bookkeeping and before the cooldown), refresh the digest for iteration `i + 1` and persist it to the bundle (best-effort, mirroring `recordStage`):

```ts
// P30: refresh the harness state digest for the next iteration
// (enforce-only; composeResume ignores it in every other mode).
if (tokenMode === "enforce") {
  stateDigest = buildStateDigest({
    runId,
    inputs,
    iteration: i,
    totalIterations: total,
    commitSubjects: commitSubjectsSince(workspaceDir, runStartSha),
    stages: readStageRecords(workspaceDir, runId),
  });
  try {
    writeFileSync(
      join(runReportDir(workspaceDir, runId), "state-digest.md"),
      stateDigest + "\n"
    );
  } catch {
    // Best-effort: never fail a run because the digest could not be written.
  }
}
```

(`runStartSha`, `readStageRecords`, `writeFileSync`, and `join` are already in scope/imported in `loop.ts` — `finalizeManifest` uses them at `:773/:868`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- state-digest`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/state-digest.ts packages/core/src/loop.ts packages/core/src/index.ts packages/core/src/__tests__/state-digest.test.ts
git commit -m "feat(p30): harness-written per-run state digest, injected via RESUME under enforce"
```

---

### Task 6: Context report — Enforced vs Advisory outcomes

**Files:**

- Modify: `packages/core/src/context-report-cli.ts` (`formatContextReportRun` at `:62`, insert before the final `return`)
- Test: `packages/core/src/__tests__/p30-context-report-enforcement.test.ts`

**Interfaces:**

- Consumes: `StageRecord.contextBudget` / `StageRecord.contextEnforcement` (Task 3); existing `num` formatter and section style in `context-report-cli.ts`.
- Produces: two new report sections — **Enforced** (one line per event: stage, lever, before → after, measured saving) and **Advisory** (over-budget stages with no events, naming the un-pulled `recommendation` lever from `assessContextBudget`). Both omitted on clean runs.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/p30-context-report-enforcement.test.ts
import { describe, expect, it } from "vitest";
import { formatContextReportRun } from "../context-report-cli.js";
import { emptyTokenUsage } from "../tokens.js";
import type { StageRecord } from "../run-report.js";

const base = (iteration: number, stage: string): StageRecord => ({
  iteration,
  stage,
  runtimeId: "claude",
  costUsd: 0,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-07-10T00:00:00Z",
  finishedAt: "2026-07-10T00:01:00Z",
  contextBreakdown: {
    totalChars: 4000,
    estimatedTokens: 1000,
    segments: [],
  },
});

describe("context report enforced vs advisory (P30)", () => {
  it("renders one Enforced line per event with its measured saving", () => {
    const enforced: StageRecord = {
      ...base(2, "implementer"),
      contextEnforcement: [
        {
          lever: "bound-learnings",
          beforeTokens: 900,
          afterTokens: 500,
          stage: "implementer",
        },
        {
          lever: "compact-commits",
          beforeTokens: 500,
          afterTokens: 480,
          stage: "implementer",
        },
      ],
    };
    const out = formatContextReportRun("run-1", [enforced]);
    expect(out).toContain("Enforced");
    expect(out).toContain("bound-learnings");
    expect(out).toContain("saved ~400");
    expect(out).toContain("compact-commits");
    expect(out).not.toContain("Advisory");
  });

  it("renders Advisory for over-budget measure-mode stages naming the lever", () => {
    const advisory: StageRecord = {
      ...base(1, "reviewer"),
      contextBudget: {
        estimatedTokens: 60_000,
        budgetTokens: 50_000,
        windowTokens: 200_000,
        overBudget: true,
        overByTokens: 10_000,
        headroomTokens: 0,
        ratio: 1.2,
        recommendation: {
          category: "learnings",
          chars: 120_000,
          lever: "bounded learnings injection (boundLearnings, slice 5)",
        },
      },
    };
    const out = formatContextReportRun("run-1", [advisory]);
    expect(out).toContain("Advisory");
    expect(out).toContain("boundLearnings");
    expect(out).toContain("--token-mode enforce");
    expect(out).not.toContain("Enforced (");
  });

  it("renders neither section on a clean run", () => {
    const out = formatContextReportRun("run-1", [base(1, "implementer")]);
    expect(out).not.toContain("Enforced");
    expect(out).not.toContain("Advisory");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- p30-context-report-enforcement`
Expected: FAIL — sections absent.

- [ ] **Step 3: Implement** — insert in `formatContextReportRun` immediately before the final `return lines.join("\n");` (after the compression section):

```ts
// P30: enforced vs advisory budget outcomes. Enforced = the degrade ladder
// ran; each application is evidenced with its measured saving. Advisory = a
// measured stage was over budget and nothing acted — the report names the
// lever that was NOT pulled and how to opt in.
const enforcedEvents = stages.flatMap((s) => s.contextEnforcement ?? []);
if (enforcedEvents.length > 0) {
  lines.push("", "  Enforced (P30 degrade ladder):");
  for (const e of enforcedEvents) {
    lines.push(
      `    ${e.stage}: ${e.lever} ~${num.format(e.beforeTokens)} → ~${num.format(
        e.afterTokens
      )} tokens (saved ~${num.format(Math.max(0, e.beforeTokens - e.afterTokens))})`
    );
  }
}
const advisoryStages = stages.filter(
  (s) =>
    s.contextBudget?.overBudget === true &&
    (s.contextEnforcement ?? []).length === 0
);
if (advisoryStages.length > 0) {
  lines.push(
    "",
    "  Advisory (over budget, not enforced — opt in with --token-mode enforce):"
  );
  for (const s of advisoryStages) {
    const a = s.contextBudget!;
    const hint = a.recommendation
      ? ` — would compact ${a.recommendation.category} via ${a.recommendation.lever}`
      : "";
    lines.push(
      `    iter${s.iteration} ${s.stage}: ~${num.format(a.estimatedTokens)} / ${num.format(
        a.budgetTokens
      )} budget${hint}`
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- p30-context-report-enforcement`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/context-report-cli.ts packages/core/src/__tests__/p30-context-report-enforcement.test.ts
git commit -m "feat(p30): context report distinguishes enforced from advisory outcomes"
```

---

### Task 7: Long-run flattening fixture + survival gate + docs

**Files:**

- Test: `packages/core/src/__tests__/p30-longrun-flattening.test.ts`
- Test: `packages/core/src/__tests__/p30-survival-gate.test.ts`
- Modify: `README.md` (`--token-mode` flag docs), `docs/CLI.md` (flag table), `docs/HARNESS_ROADMAP_PHASE6.md` (status header)

**Interfaces:**

- Consumes: `enforceContextBudget` (Task 2), `estimateTokens` (`context-report.ts:48`), `assessFactSurvival` (`compression-survival.ts:42`), `boundLearnings`/`formatBoundedLearnings` + `MemoryRecord` (`memory.ts`), `buildStateDigest` (Task 5).
- Produces: the roadmap's CI-checkable success metrics — last-third within the report's +10% band of first-third under enforcement (`context-report-cli.ts:100-112` band), and the P22 gate fixtures for both categories enforcement touches.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/__tests__/p30-longrun-flattening.test.ts
import { describe, expect, it } from "vitest";
import { enforceContextBudget } from "../context-enforcement.js";
import { estimateTokens } from "../context-report.js";

const avg = (ns: number[]): number => ns.reduce((a, b) => a + b, 0) / ns.length;

/** Nine iterations of a growing run: learnings and issue evidence accrete. */
const iterationPrompt = (i: number): string => {
  const commits = Array.from(
    { length: 5 },
    (_, k) =>
      `${"a".repeat(39)}${k}\n2026-07-0${k + 1}\nfeat: step ${i}-${k}\n\n${"verbose body line. ".repeat(60)}\n---`
  ).join("\n");
  const learnings = `# Otto learnings\n${"- prefer executeStage seams over loop edits\n".repeat(200 + 12 * i)}`;
  const issue = `Error E_TIMEOUT_42 in src/net/client.ts v1.2.3\n${"reporter narrative. ".repeat(300 + 40 * i)}`;
  return [
    "<commits>",
    commits,
    "</commits>",
    "<learnings>",
    learnings,
    "</learnings>",
    "<issue>",
    issue,
    "</issue>",
    "<inputs>fix the E_TIMEOUT_42 retry bug (issue-142)</inputs>",
    "static workflow playbook text.",
  ].join("\n");
};

const hooks = {
  renderBoundedLearnings: (budgetChars: number) =>
    `# Otto learnings\n${"- prefer executeStage seams over loop edits\n".repeat(
      Math.floor(budgetChars / 44)
    )}`,
  compressEvidence: (_tag: string, text: string) => text.slice(0, 480),
};

describe("P30 long-run token slope (roadmap success metric)", () => {
  it("flattens last-third tokens into the report's +10% band under enforcement", () => {
    const raw: number[] = [];
    const enforced: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const prompt = iterationPrompt(i);
      raw.push(estimateTokens(prompt.length));
      const r = enforceContextBudget(prompt, {
        stage: "implementer",
        maxTokens: 2000,
        hooks,
      });
      enforced.push(r.assessment.estimatedTokens);
    }
    const firstRaw = avg(raw.slice(0, 3));
    const lastRaw = avg(raw.slice(-3));
    expect(lastRaw / firstRaw).toBeGreaterThan(1.2); // the fixture really grows
    const firstEnforced = avg(enforced.slice(0, 3));
    const lastEnforced = avg(enforced.slice(-3));
    expect(lastEnforced).toBeLessThanOrEqual(firstEnforced * 1.1); // the band
  });
});
```

```ts
// packages/core/src/__tests__/p30-survival-gate.test.ts
import { describe, expect, it } from "vitest";
import { assessFactSurvival } from "../compression-survival.js";
import { enforceContextBudget } from "../context-enforcement.js";
import {
  boundLearnings,
  formatBoundedLearnings,
  type MemoryRecord,
} from "../memory.js";

const record = (
  id: string,
  content: string,
  confidence: number
): MemoryRecord => ({
  id,
  content,
  scope: [],
  confidence,
  trust: "trusted",
  status: "active",
  createdAt: "2026-07-01T00:00:00Z",
  useCount: 3,
});

const FACT = "OTTO_HEADROOM_BIN must stay on PATH for command-mode compression";
const records: MemoryRecord[] = [
  record("2026-07-01-a", FACT, 0.95),
  ...Array.from({ length: 40 }, (_, i) =>
    record(
      `2026-06-0${(i % 9) + 1}-${i}`,
      `minor observation ${i} `.repeat(8),
      0.4
    )
  ),
];

describe("P30 survival gate — bounded learnings at the halved budget (P22)", () => {
  it("keeps the highest-relevance load-bearing fact at 3000 chars", () => {
    const text = formatBoundedLearnings(
      boundLearnings(records, { maxChars: 3000 })
    );
    expect(assessFactSurvival([FACT], text).survivalRate).toBe(1);
  });
});

describe("P30 survival gate — the ladder end-to-end keeps buried facts", () => {
  it("survives the fact through a memory-backed lever (a) application", () => {
    const prompt = [
      "<learnings>",
      `# Otto learnings\n${records.map((r) => `- ${r.content}`).join("\n")}`,
      "</learnings>",
      "<inputs>tune the compressor</inputs>",
    ].join("\n");
    const r = enforceContextBudget(prompt, {
      stage: "implementer",
      maxTokens: 200,
      hooks: {
        renderBoundedLearnings: (budgetChars) =>
          formatBoundedLearnings(
            boundLearnings(records, { maxChars: budgetChars })
          ),
      },
    });
    expect(r.events.map((e) => e.lever)).toContain("bound-learnings");
    expect(assessFactSurvival([FACT], r.prompt).survivalRate).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify current state**

Run: `pnpm --filter @phamvuhoang/otto-core test -- p30-longrun-flattening` and `pnpm --filter @phamvuhoang/otto-core test -- p30-survival-gate`
Expected: PASS immediately if Tasks 2–5 are correct — these are the acceptance fixtures. If either fails, fix the ladder (not the fixture): a failing survival fixture means enforcement is not shippable (the P22 gate).

- [ ] **Step 3: Docs**

- `README.md`: extend the `--token-mode` entry — `enforce` = measure + governed degrade ladder (bounded learnings → reversible evidence compression → commit compaction), the state digest, and the bounded resume chain; note it is opt-in, every action is visible in `--context-report`, and originals stay retrievable in the run bundle.
- `docs/CLI.md`: update the flag table row for `--token-mode` (four values) and add `.otto/config.json` `"tokenMode"` to the config keys.
- `docs/HARNESS_ROADMAP_PHASE6.md`: update the `> **Status:**` header to record that the P30 implementation slice has landed (enforce tier + digest), leaving the other initiatives planned.

- [ ] **Step 4: Full verify**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/__tests__/p30-longrun-flattening.test.ts packages/core/src/__tests__/p30-survival-gate.test.ts README.md docs/CLI.md docs/HARNESS_ROADMAP_PHASE6.md
git commit -m "feat(p30): long-run flattening + P22 survival gate fixtures + docs"
```

---

## Self-Review Notes

- **Spec coverage:** enforce tier flag/env/config (T1), degrade ladder + events + resume bound (T2), enforcement point + stage/manifest evidence (T3), P29-lever hook + manifest rollup + bounded RESUME composition (T4), state digest + retrievable-evidence pointers (T5), enforced-vs-advisory reporting (T6), roadmap success metrics + P22 survival gate + docs (T7). All four numbered P30 scope items (roadmap §P30) map to tasks: enforcement tier → T1–T4, retirement digest → T5, resumeNote bound → T2+T4, report distinction → T6.
- **P29 dependency (explicit):** lever (a) consumes the `boundLearnings`/`formatBoundedLearnings`/`readMemoryRecords` substrate P29 wires as the `{{ LEARNINGS }}` path; T4's hook is buildable against `memory.ts` today, but the halving baseline (`learningsBudgetChars`) should be fed P29's active budget once it lands, and lever (b)'s category set assumes #200's `isCompressibleCategory` (branch `fix/phase5-review-findings`) is merged. Land P29 + #200 before or with T4.
- **Never-truncate guarantee:** structurally enforced — `enforceContextBudget` can only rewrite `<learnings>`, the three evidence tags, and `<commits>`; T2 and T3 both assert `<inputs>`/playbook bytes survive.
- **Byte-for-byte default:** `off`/`measure`/`reduce` paths take no new branches that alter the prompt (T3 test 3, plus the pre-existing `stage-exec.test.ts` suite unchanged); `composeResume` returns the raw note outside enforce (T4 test 1); the digest is only built under enforce (T5 wiring).
- **Type consistency:** `ContextEnforcementEvent`/`EnforcementSummary` defined in T2, consumed by `StageResult`/`StageRecord`/`RunManifest` (T3), the loop rollup (T4), and the report (T6). `ContextBudgetAssessment` reused from `context-budget.ts` unchanged — `assessContextBudget` itself is not modified anywhere.
- **Known weak rung, stated:** default templates inject subject-only commits (`%s` format), so `compact-commits` often saves ~0 there; events stay visible rather than suppressed (spec risk bullet), and the rung matters on verbose bodies / `-n 15` templates.
- **Deferred (spec out-of-scope, intentionally not planned):** P29's template conversion and dedup, P27 attested checks (digest reads verification rows only "if present"), live `otto-eval` A/B benchmark runs (operator workflow, not CI).
