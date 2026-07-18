# P29 Prompt Diet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut per-iteration prompt cost by wiring the levers that already exist: bounded learnings injection (`boundLearnings` substrate, harness-rendered `{{ LEARNINGS }}`), a real executed lean ghafk issue index, one shared review-diff spill across panel lenses, static-first entry templates for a cacheable prefix, the dead `memory-projection` compressor category fed, and an honest `--token-mode reduce`.

**Architecture:** `memory.ts` gains a pure resolution rule (`resolveLearningsBlock`: byte-parity passthrough under the 6000-char budget, bounded projection from governed records over it, never truncating a record-less file) plus an fs wrapper (`learningsForPrompt`, honoring `OTTO_UNBOUNDED_LEARNINGS=1`). `stage-exec.ts` defaults `vars.LEARNINGS` through `prepareLearnings`, which routes the text through `compressContentSync` (category `memory-projection`) when the compressor is on — one wiring point covering the loop, panel substages, and fan-out. Templates swap the `!?`cat``tag for`{{ LEARNINGS }}`, `ghafk.md`gets its missing`!?`on a`--jq`-leaned summary, `panel.ts`spills`head.diff`once per iteration into`panelHostDir`and shares the path via`{{ DIFF_FILE }}`, and the three GitHub/plan entry templates are reordered static-first. `prompt-reduction.ts`wires`compactCommits` and drops its fake cache stats.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥20, vitest. `packages/core` only. No new npm dependencies (`--jq` is built into `gh`).

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **Byte parity for small repos.** A `LEARNINGS.md` under the 6000-char budget injects char-for-char what the `!?`cat``tag produced (trailing newline trimmed, exact`_No learnings recorded yet._`fallback).`OTTO_UNBOUNDED_LEARNINGS=1` restores whole-file injection unconditionally.
- **Never silently truncate.** Over budget with no `.otto/memory/` records ⇒ verbatim passthrough.
- **Render security invariant** (`render.ts:12-17`): no template var ever reaches a shell command body; all new/edited shell tags stay static strings.
- **Compressor stays opt-in.** `memory-projection` compression runs only when `--context-compressor headroom` already enabled it — same gate as spill compression.
- **Fresh process per stage is untouched.** Prompts are shaped and bounded; nothing carries a transcript forward.
- **Templates ship in the tarball** — edits only, no new template files.
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit runs prettier + typecheck.
- **Never hand-edit release version state.** release-please owns it.

---

### Task 1: Bounded-learnings resolution (`resolveLearningsBlock` + `learningsForPrompt`)

**Files:**

- Modify: `packages/core/src/memory.ts` (below `formatBoundedLearnings` at `:471`)
- Modify: `packages/core/src/index.ts` (extend the `./memory.js` export block at `:213-240`)
- Test: `packages/core/src/__tests__/learnings-bound.test.ts`

**Interfaces:**

- Consumes: `DEFAULT_LEARNINGS_BUDGET_CHARS` (`memory.ts:374`), `boundLearnings` (`:443`), `formatBoundedLearnings` (`:471`), `readMemoryRecords` (`:529`), `MemorySelectionContext`, `MemoryRecord`.
- Produces:
  - `export const LEARNINGS_FALLBACK = "_No learnings recorded yet._";`
  - `export type LearningsResolution = { text: string; bounded: boolean; rawChars: number; droppedCount?: number };`
  - `export function resolveLearningsBlock(raw: string | null, records: MemoryRecord[], ctx?: MemorySelectionContext & { unbounded?: boolean }): LearningsResolution` — pure.
  - `export function learningsForPrompt(workspaceDir: string, ctx?: MemorySelectionContext, env?: NodeJS.ProcessEnv): LearningsResolution` — reads `.otto/LEARNINGS.md` + `readMemoryRecords`, maps `env.OTTO_UNBOUNDED_LEARNINGS === "1"` to `unbounded`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/learnings-bound.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LEARNINGS_BUDGET_CHARS,
  LEARNINGS_FALLBACK,
  learningsForPrompt,
  resolveLearningsBlock,
  writeMemoryRecord,
  type MemoryRecord,
} from "../memory.js";

// Always-active record: no freshness fields, so `now` never stales it.
const rec = (id: string, content: string, confidence = 0.9): MemoryRecord => ({
  id,
  content,
  category: "convention",
  scope: [],
  confidence,
  trust: "trusted",
  status: "active",
  createdAt: "2026-07-01T00:00:00.000Z",
  useCount: 1,
});

describe("resolveLearningsBlock", () => {
  it("passes a small file through byte-identically (trailing newline trimmed)", () => {
    const out = resolveLearningsBlock("## Gotchas\n- pnpm not npm\n", []);
    expect(out.text).toBe("## Gotchas\n- pnpm not npm");
    expect(out.bounded).toBe(false);
  });

  it("uses the exact try-shell fallback when the file is absent", () => {
    expect(resolveLearningsBlock(null, []).text).toBe(LEARNINGS_FALLBACK);
    expect(LEARNINGS_FALLBACK).toBe("_No learnings recorded yet._");
  });

  it("bounds an over-budget file from governed records, with the omission note", () => {
    const raw = "x".repeat(DEFAULT_LEARNINGS_BUDGET_CHARS + 1);
    const records = [
      rec("2026-07-02T00-00-00-000Z-a", "keep: high-value convention", 0.95),
      rec("2026-07-01T00-00-00-000Z-b", "z".repeat(7000), 0.3),
    ];
    const out = resolveLearningsBlock(raw, records);
    expect(out.bounded).toBe(true);
    expect(out.text).toContain("keep: high-value convention");
    expect(out.text).not.toContain("z".repeat(7000));
    expect(out.text).toContain("omitted to fit the 6000-char");
    expect(out.droppedCount).toBe(1);
  });

  it("never truncates an over-budget file when there are no governed records", () => {
    const out = resolveLearningsBlock("y".repeat(9000) + "\n", []);
    expect(out.text).toBe("y".repeat(9000));
    expect(out.bounded).toBe(false);
  });

  it("unbounded: true always passes the raw file through", () => {
    const out = resolveLearningsBlock(
      "w".repeat(9000),
      [rec("2026-07-01T00-00-00-000Z-a", "selected")],
      { unbounded: true }
    );
    expect(out.text).toBe("w".repeat(9000));
    expect(out.bounded).toBe(false);
  });
});

describe("learningsForPrompt", () => {
  it("reads the workspace file + records and honors OTTO_UNBOUNDED_LEARNINGS", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-lfp-"));
    try {
      mkdirSync(join(ws, ".otto"), { recursive: true });
      writeFileSync(
        join(ws, ".otto", "LEARNINGS.md"),
        "k".repeat(7000),
        "utf8"
      );
      writeMemoryRecord(
        ws,
        rec("2026-07-01T00-00-00-000Z-a", "selected content")
      );
      expect(learningsForPrompt(ws, {}, {}).text).toContain("selected content");
      expect(
        learningsForPrompt(ws, {}, { OTTO_UNBOUNDED_LEARNINGS: "1" }).text
      ).toBe("k".repeat(7000));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back when the workspace has no LEARNINGS.md", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-lfp-"));
    try {
      expect(learningsForPrompt(ws, {}, {}).text).toBe(LEARNINGS_FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- learnings-bound`
Expected: FAIL — `resolveLearningsBlock` / `LEARNINGS_FALLBACK` not exported.

- [ ] **Step 3: Implement in `memory.ts`** (after `formatBoundedLearnings`; `readFileSync`/`join` are already imported at `:1-2`)

````ts
/** The exact fallback the replaced `!?`cat ./.otto/LEARNINGS.md``` tags used —
 *  preserved verbatim so absent-file behavior is byte-identical (P29). */
export const LEARNINGS_FALLBACK = "_No learnings recorded yet._";

/** How the `{{ LEARNINGS }}` block was resolved, for evidence and tests. */
export type LearningsResolution = {
  /** The text substituted into the `<learnings>` block. */
  text: string;
  /** True when the bounded projection replaced the raw file. */
  bounded: boolean;
  /** Chars of the raw LEARNINGS.md (0 when absent). */
  rawChars: number;
  /** Records the budget dropped (present only when bounded). */
  droppedCount?: number;
};

/**
 * Resolve the learnings block for a prompt (P29). Byte parity with the replaced
 * try-shell tag: a file that fits the budget passes through verbatim with one
 * trailing newline trimmed (render.ts trims try-shell output the same way), and
 * an absent file yields {@link LEARNINGS_FALLBACK}. Over budget, the governed
 * records are bounded via {@link boundLearnings} + {@link formatBoundedLearnings}
 * (which appends the honest omission note); with no records to select from, the
 * raw file passes through untouched — never silently truncate a hand-maintained
 * file. `unbounded: true` (the OTTO_UNBOUNDED_LEARNINGS=1 escape hatch) always
 * passes the raw file through. Pure.
 */
export function resolveLearningsBlock(
  raw: string | null,
  records: MemoryRecord[],
  ctx: MemorySelectionContext & { unbounded?: boolean } = {}
): LearningsResolution {
  const verbatim =
    raw === null ? LEARNINGS_FALLBACK : raw.replace(/\r?\n$/, "");
  const rawChars = raw?.length ?? 0;
  const budget = ctx.maxChars ?? DEFAULT_LEARNINGS_BUDGET_CHARS;
  if (ctx.unbounded === true || raw === null || raw.length <= budget) {
    return { text: verbatim, bounded: false, rawChars };
  }
  if (records.length === 0) {
    return { text: verbatim, bounded: false, rawChars };
  }
  const bounded = boundLearnings(records, ctx);
  const text = formatBoundedLearnings(bounded, ctx.now ?? new Date()).replace(
    /\r?\n$/,
    ""
  );
  return {
    text,
    bounded: true,
    rawChars,
    droppedCount: bounded.dropped.length,
  };
}

/**
 * Read a workspace's learnings state and resolve the prompt block (P29). The
 * impure shell around {@link resolveLearningsBlock}: reads `.otto/LEARNINGS.md`
 * (absent/unreadable → null) and the governed records, and maps the
 * `OTTO_UNBOUNDED_LEARNINGS=1` escape hatch onto `unbounded`. Never throws.
 */
export function learningsForPrompt(
  workspaceDir: string,
  ctx: MemorySelectionContext = {},
  env: NodeJS.ProcessEnv = process.env
): LearningsResolution {
  let raw: string | null = null;
  try {
    raw = readFileSync(join(workspaceDir, ".otto", "LEARNINGS.md"), "utf8");
  } catch {
    raw = null;
  }
  return resolveLearningsBlock(raw, readMemoryRecords(workspaceDir), {
    ...ctx,
    unbounded: env.OTTO_UNBOUNDED_LEARNINGS === "1",
  });
}
````

Add `LEARNINGS_FALLBACK`, `learningsForPrompt`, `resolveLearningsBlock`, and `type LearningsResolution` to the `./memory.js` export block in `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- learnings-bound`
Expected: PASS (7 tests). Also run `pnpm --filter @phamvuhoang/otto-core test -- memory` to confirm the existing suite is untouched.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/memory.ts packages/core/src/index.ts packages/core/src/__tests__/learnings-bound.test.ts
git commit -m "feat(p29): bounded-learnings resolution with byte-parity floor and escape hatch"
```

---

### Task 2: `prepareLearnings` in `stage-exec.ts` — default `{{ LEARNINGS }}`, feed `memory-projection`

**Files:**

- Modify: `packages/core/src/stage-exec.ts` (new exported helper; wire into `executeStage` before the `renderTemplate` call at `:153`)
- Test: `packages/core/src/__tests__/prepare-learnings.test.ts`

**Interfaces:**

- Consumes: `learningsForPrompt`, `LEARNINGS_FALLBACK` (Task 1); `compressContentSync` (`context-compressor.ts:306`), `compressionToolUsage` (`:351`), `SyncContextCompressor`, `RetrievalStore` (already imported in `stage-exec.ts:5-11`); `ToolUsage`.
- Produces:
  - `export type PreparedLearnings = { text: string; toolUsage?: ToolUsage };`
  - `export function prepareLearnings(opts: { workspaceDir: string; iteration: number; label: string; stageName: string; compressor?: SyncContextCompressor | null; retrievalStore?: RetrievalStore | null; env?: NodeJS.ProcessEnv }): PreparedLearnings` — resolves the block; when a compressor + retrieval store are present and the text is not the fallback, routes it through `compressContentSync` with category `"memory-projection"` and key `` `${iteration}-${label}-learnings` ``, returning the (possibly compressed) text + a `compressionToolUsage` evidence record. The non-shrinking/degrade rules are `assembleOutput`'s (`context-compressor.ts:216`): originals are kept unless the estimate shrinks.
  - `executeStage` defaults `vars.LEARNINGS` via `prepareLearnings` when the caller did not supply it; the evidence record joins the existing per-attempt `toolsUsed` array.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/prepare-learnings.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLearnings } from "../stage-exec.js";
import type { SyncContextCompressor } from "../context-compressor.js";

function ws(learnings: string): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-prep-"));
  mkdirSync(join(dir, ".otto"), { recursive: true });
  writeFileSync(join(dir, ".otto", "LEARNINGS.md"), learnings, "utf8");
  return dir;
}

const shrinker: SyncContextCompressor = {
  name: "stub",
  version: "stub-1",
  available: true,
  compress: (input) => ({ ok: true, text: input.text.slice(0, 20) }),
};

describe("prepareLearnings", () => {
  it("feeds the memory-projection category and records ToolUsage evidence", () => {
    const dir = ws(
      "## Conventions\n- a durable convention worth compressing\n"
    );
    const stored: Record<string, string> = {};
    try {
      const out = prepareLearnings({
        workspaceDir: dir,
        iteration: 3,
        label: "implementer",
        stageName: "implementer",
        compressor: shrinker,
        retrievalStore: (key, original) => {
          stored[key] = original;
          return `handle:${key}`;
        },
        env: {},
      });
      expect(out.text).toBe("## Conventions\n- a d");
      expect(out.toolUsage?.reasons).toContain("compressed memory-projection");
      expect(out.toolUsage?.retrievalHandle).toBe(
        "handle:3-implementer-learnings"
      );
      expect(stored["3-implementer-learnings"]).toContain("durable convention");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the original when the compressor does not shrink", () => {
    const dir = ws("- tiny\n");
    try {
      const out = prepareLearnings({
        workspaceDir: dir,
        iteration: 1,
        label: "implementer",
        stageName: "implementer",
        compressor: {
          ...shrinker,
          compress: (i) => ({ ok: true, text: i.text + i.text }),
        },
        retrievalStore: () => "unused",
        env: {},
      });
      expect(out.text).toBe("- tiny");
      expect(out.toolUsage?.retrievalHandle).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a plain resolution with no evidence when the compressor is off", () => {
    const dir = ws("- tiny\n");
    try {
      const out = prepareLearnings({
        workspaceDir: dir,
        iteration: 1,
        label: "implementer",
        stageName: "implementer",
        compressor: null,
        retrievalStore: null,
        env: {},
      });
      expect(out.text).toBe("- tiny");
      expect(out.toolUsage).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never compresses the fallback placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-prep-"));
    try {
      const out = prepareLearnings({
        workspaceDir: dir,
        iteration: 1,
        label: "x",
        stageName: "x",
        compressor: shrinker,
        retrievalStore: () => "h",
        env: {},
      });
      expect(out.text).toBe("_No learnings recorded yet._");
      expect(out.toolUsage).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- prepare-learnings`
Expected: FAIL — `prepareLearnings` not exported.

- [ ] **Step 3: Implement + wire**

In `stage-exec.ts`, extend the `./context-compressor.js` import with `compressContentSync` and `compressionToolUsage` (both value imports; the type imports at `:5-11` stay), add `import { LEARNINGS_FALLBACK, learningsForPrompt } from "./memory.js";`, then add:

```ts
/** The resolved (and, when the compressor is on, compressed) learnings block. */
export type PreparedLearnings = { text: string; toolUsage?: ToolUsage };

/**
 * Default value for the `{{ LEARNINGS }}` template var (P29): the bounded
 * resolution from `learningsForPrompt`, routed through the sync compressor with
 * the previously-dead `memory-projection` category when compression is on. The
 * fallback placeholder is never compressed (nothing to save, nothing to store).
 */
export function prepareLearnings(opts: {
  workspaceDir: string;
  iteration: number;
  label: string;
  stageName: string;
  compressor?: SyncContextCompressor | null;
  retrievalStore?: RetrievalStore | null;
  env?: NodeJS.ProcessEnv;
}): PreparedLearnings {
  const resolved = learningsForPrompt(
    opts.workspaceDir,
    {},
    opts.env ?? process.env
  );
  if (
    !opts.compressor ||
    !opts.retrievalStore ||
    resolved.text === LEARNINGS_FALLBACK
  ) {
    return { text: resolved.text };
  }
  const out = compressContentSync(
    opts.compressor,
    {
      key: `${opts.iteration}-${opts.label}-learnings`,
      category: "memory-projection",
      text: resolved.text,
    },
    opts.retrievalStore
  );
  return {
    text: out.text,
    toolUsage: compressionToolUsage(out, "memory-projection", opts.stageName),
  };
}
```

In `executeStage`, inside the `withRetries` body directly after `const toolsUsed: ToolUsage[] = [];` (`:135`), default the var and pass `stageVars` (not `vars`) to `renderTemplate` at `:153`:

```ts
// P29: default {{ LEARNINGS }} to the bounded (and, under the compressor,
// memory-projection-compressed) block. A caller-supplied vars.LEARNINGS
// wins; templates without the tag are unaffected (renderTemplate leaves
// unknown {{ TAG }}s untouched and unused vars substitute nowhere).
let stageVars = vars;
if (!("LEARNINGS" in stageVars)) {
  const learnings = prepareLearnings({
    workspaceDir,
    iteration,
    label,
    stageName: stage.name,
    compressor: opts.compressor,
    retrievalStore: opts.retrievalStore,
  });
  stageVars = { ...stageVars, LEARNINGS: learnings.text };
  if (learnings.toolUsage) toolsUsed.push(learnings.toolUsage);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- prepare-learnings`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/stage-exec.ts packages/core/src/__tests__/prepare-learnings.test.ts
git commit -m "feat(p29): executeStage defaults {{ LEARNINGS }} and feeds memory-projection compression"
```

---

### Task 3: Swap the six templates' `<learnings>` bodies to `{{ LEARNINGS }}`

**Files:**

- Modify: `packages/core/templates/afk.md` (`:11`), `ghafk.md` (`:11`), `ghafk-issue.md` (`:9`), `review.md` (`:17`), `review-lens.md` (`:11`), `verify.md` (`:11`)
- Modify: `packages/core/src/__tests__/learnings.test.ts` (render through the harness resolution)

**Interfaces:**

- Consumes: `learningsForPrompt` (Task 1); `renderTemplate` unknown-tag behavior (`render.ts:213-215`).
- Produces: identical template edit in all six files. The other seven `cat` templates (`plan.md`, `apply-review.md`, `linearafk.md`, `linearafk-issue.md`, `review-verify.md`, `review-synth.md`, `subtask.md`) are **not** touched this slice.

- [ ] **Step 1: Edit the six templates.** Each contains this exact block (at the lines listed above); the edit is identical in every file.

Before:

```
<learnings>

!?`cat ./.otto/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>
```

After:

```
<learnings>

{{ LEARNINGS }}

</learnings>
```

- [ ] **Step 2: Update `learnings.test.ts` to the harness-rendered contract** (full replacement — the old suite asserted the `cat` tag rendered the file directly):

```ts
// packages/core/src/__tests__/learnings.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";
import { learningsForPrompt } from "../memory.js";

const TEMPLATES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates"
);
const FALLBACK = "No learnings recorded yet";

function makeWorkspace(learnings?: string): string {
  const ws = mkdtempSync(join(tmpdir(), "otto-learn-"));
  if (learnings !== undefined) {
    mkdirSync(join(ws, ".otto"), { recursive: true });
    writeFileSync(join(ws, ".otto", "LEARNINGS.md"), learnings, "utf8");
  }
  return ws;
}

function renderAfk(ws: string): string {
  return renderTemplate(
    join(TEMPLATES, "afk.md"),
    {
      INPUTS: "plan",
      RESUME: "",
      LEARNINGS: learningsForPrompt(ws, {}, {}).text,
    },
    { cwd: ws }
  );
}

describe("learnings block — harness-rendered {{ LEARNINGS }} (P29)", () => {
  it("injects .otto/LEARNINGS.md into the implementer (afk) prompt via the var", () => {
    const ws = makeWorkspace("## Gotchas\n- pnpm not npm\n");
    try {
      const out = renderAfk(ws);
      expect(out).toContain("- pnpm not npm");
      expect(out).not.toContain(FALLBACK);
      expect(out).not.toContain("{{ LEARNINGS }}");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back when .otto/LEARNINGS.md is absent (afk)", () => {
    const ws = makeWorkspace();
    try {
      expect(renderAfk(ws)).toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("review-synth keeps the direct cat injection (out of P29 scope)", () => {
    const ws = makeWorkspace("## Decisions\n- chose X over Y\n");
    try {
      const out = renderTemplate(
        join(TEMPLATES, "review-synth.md"),
        {},
        { cwd: ws }
      );
      expect(out).toContain("- chose X over Y");
      expect(out).not.toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the affected suites**

Run: `pnpm --filter @phamvuhoang/otto-core test -- learnings`
Expected: PASS (`learnings.test.ts` + `learnings-bound.test.ts`). Also run `pnpm --filter @phamvuhoang/otto-core test -- review-lens` — the existing suite passes vars `{ LENS }` only, and its assertions do not touch the learnings block, so the untouched `{{ LEARNINGS }}` literal is harmless until Task 5 updates that helper.

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/templates/afk.md packages/core/templates/ghafk.md packages/core/templates/ghafk-issue.md packages/core/templates/review.md packages/core/templates/review-lens.md packages/core/templates/verify.md packages/core/src/__tests__/learnings.test.ts
git commit -m "feat(p29): six entry templates take harness-rendered bounded {{ LEARNINGS }}"
```

---

### Task 4: Real executed lean `<issues-summary>` in `ghafk.md`

**Files:**

- Modify: `packages/core/templates/ghafk.md` (`:15-19`)
- Modify: `packages/core/src/__tests__/ghafk-templates.test.ts` (new describe block)

**Interfaces:**

- Consumes: `render.ts` `SHELL_TRY_TAG` (`:20`) — the current summary line has **no `!` prefix**, so today it renders as literal text and is never executed; the docs (`docs/ARCHITECTURE.md:302`) already describe it as executed. This task makes the template match the documented (and roadmap-audited) two-view model, leanly.
- Produces: a `!?`-executed summary with a `|||[]` fallback and gh's built-in `--jq` shrinking label objects to names. The full dump spill (`:23`) is unchanged.

- [ ] **Step 1: Extend `ghafk-templates.test.ts`** — append this describe block (the existing scope/security invariants automatically cover the new command body):

```ts
describe("ghafk <issues-summary> — executed lean index (P29)", () => {
  const summaryBlock = (): string => {
    const raw = readFileSync(tpl("ghafk.md"), "utf8");
    const m = raw.match(/<issues-summary>([\s\S]*?)<\/issues-summary>/);
    expect(m).not.toBeNull();
    return m![1];
  };

  it("is a harness-executed try-shell tag with a JSON fallback", () => {
    const summary = summaryBlock();
    expect(summary).toMatch(/!\?`gh issue list /);
    expect(summary).toContain("|||[]");
    // The pre-P29 bug: a bare backticked command the renderer never executes.
    expect(summary).not.toMatch(/^\s*`gh issue list/m);
  });

  it("keeps the inline payload lean: number/title/label names only", () => {
    const summary = summaryBlock();
    expect(summary).toContain("--json number,title,labels");
    expect(summary).toContain(".labels[].name");
    expect(summary).not.toContain("body");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- ghafk-templates`
Expected: FAIL — the summary block is a bare backticked command (no `!?`, no fallback, no `--jq`).

- [ ] **Step 3: Edit the template block**

Before (`ghafk.md:15-19`):

```
<issues-summary>

`gh issue list ${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"} --state open --limit 50 --json number,title,labels`

</issues-summary>
```

After:

```
<issues-summary>

!?`gh issue list ${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"} --state open --limit 50 --json number,title,labels --jq 'map({number: .number, title: .title, labels: [.labels[].name]})'|||[]`

</issues-summary>
```

(`--jq` is gh's embedded jq — no external dependency; single quotes contain no backticks so the tag body parses; `|||[]` degrades to an empty list when `gh` is absent or unauthenticated, matching the full-dump spill's fallback at `:23`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- ghafk-templates`
Expected: PASS — including the pre-existing scope-fragment, no-`{{`-in-shell, and validated-env-var invariants over the new body.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/templates/ghafk.md packages/core/src/__tests__/ghafk-templates.test.ts
git commit -m "feat(p29): ghafk issues-summary is a real executed lean index"
```

---

### Task 5: One review-diff spill per iteration, shared across panel lenses

**Files:**

- Modify: `packages/core/src/panel.ts` (new exported `spillHeadDiff`; wire into `runPanel` at `:223-241`; lens vars at `:271`)
- Modify: `packages/core/templates/review-lens.md` (`:19`)
- Modify: `packages/core/src/__tests__/review-lens.test.ts` (render helper vars)
- Test: `packages/core/src/__tests__/panel-diff-spill.test.ts`

**Interfaces:**

- Consumes: `panelHostDir`/`panelRel` (`panel.ts:223-225`), `findingsDirRef` (`:241`), lens `executeStage` vars (`:271`), `writeFileSync`/`join`/`posix` (already imported in `panel.ts:1-2`).
- Produces:
  - `export function spillHeadDiff(workspaceDir: string, panelHostDir: string): string` — writes `git show HEAD` (64 MiB buffer, matching `render.ts`'s `SPILL_MAX_BUFFER`) to `<panelHostDir>/head.diff`, falling back to the old `@spill` tag's `No diff body`; returns the absolute path.
  - Lens vars gain `DIFF_FILE` — the workspace-relative POSIX path — so all lenses in an iteration reference **one identical** path (the per-lens `@spill` previously ran `git show HEAD` N times into N unique dirs, `stage-exec.ts:118`, so lens prompts could never share a cached prefix).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/panel-diff-spill.test.ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spillHeadDiff } from "../panel.js";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-paneldiff-"));
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "otto@test"]);
  run(["config", "user.name", "otto"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "hello.txt"), "hello p29\n", "utf8");
  run(["add", "hello.txt"]);
  run(["commit", "-q", "-m", "feat: p29 fixture"]);
  return dir;
}

describe("spillHeadDiff (P29 shared panel diff)", () => {
  it("writes the HEAD patch once into the panel dir and returns the path", () => {
    const ws = gitRepo();
    const panelDir = join(ws, ".otto-tmp", "panel-test");
    mkdirSync(panelDir, { recursive: true });
    try {
      const target = spillHeadDiff(ws, panelDir);
      expect(target).toBe(join(panelDir, "head.diff"));
      const patch = readFileSync(target, "utf8");
      expect(patch).toContain("feat: p29 fixture");
      expect(patch).toContain("hello p29");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back to the documented placeholder when there is no commit", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-paneldiff-"));
    execFileSync("git", ["init", "-q"], { cwd: ws, stdio: "ignore" });
    const panelDir = join(ws, "panel");
    mkdirSync(panelDir, { recursive: true });
    try {
      spillHeadDiff(ws, panelDir);
      expect(readFileSync(join(panelDir, "head.diff"), "utf8")).toBe(
        "No diff body"
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- panel-diff-spill`
Expected: FAIL — `spillHeadDiff` not exported.

- [ ] **Step 3: Implement + wire + edit the template**

In `panel.ts`, add `import { execFileSync } from "node:child_process";` and:

```ts
/**
 * Spill the HEAD patch ONCE per panel iteration (P29). Every lens shares the
 * same file via {{ DIFF_FILE }}, replacing the per-lens `git show HEAD` @spill
 * whose unique spill path made lens prompts diverge and never share a cached
 * prefix. 64 MiB buffer mirrors render.ts's SPILL_MAX_BUFFER; failure (no
 * commit yet) degrades to the old tag's `No diff body` fallback.
 */
export function spillHeadDiff(
  workspaceDir: string,
  panelHostDir: string
): string {
  let patch: string;
  try {
    patch = execFileSync("git", ["show", "HEAD"], {
      cwd: workspaceDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    patch = "No diff body";
  }
  const target = join(panelHostDir, "head.diff");
  writeFileSync(target, patch, "utf8");
  return target;
}
```

In `runPanel`, next to `findingsDirRef` (`:241`):

```ts
const findingsDirRef = `./${posix.join(".otto-tmp", panelRel)}/`;
// P29: one shared diff spill for the whole lens batch.
spillHeadDiff(workspaceDir, panelHostDir);
const diffFileRef = `${findingsDirRef}head.diff`;
```

and thread it into the lens vars (`:271`):

```ts
        vars: { LENS: lens, RESUME: resumeNote, DIFF_FILE: diffFileRef },
```

In `review-lens.md`, before (`:19`):

```
Full patch spilled to: @spill?:head.diff=`git show HEAD|||No diff body`
```

After:

```
Full patch spilled to: {{ DIFF_FILE }}
```

In `review-lens.test.ts`, update the `render` helper — the template no longer uses `@spill`, so the spill dirs go away and the shared vars are passed explicitly:

```ts
function render(lens: string): string {
  const ws = mkdtempSync(join(tmpdir(), "otto-lens-"));
  try {
    return renderTemplate(
      reviewLensTpl,
      {
        LENS: lens,
        LEARNINGS: "_No learnings recorded yet._",
        DIFF_FILE: "./.otto-tmp/panel-1/head.diff",
      },
      { cwd: ws }
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}
```

and append the cache-shape pin to that file:

```ts
describe("lens prompt cache shape (P29)", () => {
  it("two lenses share an identical prefix through the <latest-diff> block", () => {
    const a = render("correctness");
    const b = render("security");
    const marker = "# REVIEWER —";
    expect(a.indexOf(marker)).toBeGreaterThan(0);
    expect(a.slice(0, a.indexOf(marker))).toBe(b.slice(0, b.indexOf(marker)));
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- panel-diff-spill` then `pnpm --filter @phamvuhoang/otto-core test -- review-lens` and `pnpm --filter @phamvuhoang/otto-core test -- panel`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/src/panel.ts packages/core/templates/review-lens.md packages/core/src/__tests__/panel-diff-spill.test.ts packages/core/src/__tests__/review-lens.test.ts
git commit -m "feat(p29): panel spills the review diff once and shares it across lenses"
```

---

### Task 6: Static-first entry templates (`afk.md`, `ghafk.md`, `ghafk-issue.md`)

**Files:**

- Modify: `packages/core/templates/afk.md`, `ghafk.md`, `ghafk-issue.md` (reorder), `prompt.md` (`:3`), `ghprompt.md` (`:3`, `:10`)
- Test: `packages/core/src/__tests__/template-order.test.ts`

**Interfaces:**

- Consumes: nothing new — pure template reshaping so the ~400-line static playbook chain (`prompt.md`/`ghprompt.md`/`ghprompt-workflow.md` + their includes) renders **before** any per-iteration dynamic block, forming a stable prompt prefix the runtime's prompt caching can reuse (measured by the `cache_read_input_tokens` the runner already parses — `tokens.ts:38`).
- `review.md`/`verify.md`/linear templates and `review-lens.md` are deliberately not reordered this slice (spec decision 6).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/template-order.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tpl = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../templates/${name}`, import.meta.url)),
    "utf8"
  );

describe("static-first entry templates (P29 cache shape)", () => {
  it("afk.md puts the playbook include before every dynamic block", () => {
    const raw = tpl("afk.md");
    const include = raw.indexOf("@include:prompt.md");
    expect(include).toBeGreaterThanOrEqual(0);
    for (const dyn of [
      "{{ RESUME }}",
      "<commits>",
      "<learnings>",
      "<inputs>",
    ]) {
      expect(include).toBeLessThan(raw.indexOf(dyn));
    }
  });

  it("ghafk.md puts the playbook include before every dynamic block", () => {
    const raw = tpl("ghafk.md");
    const include = raw.indexOf("@include:ghprompt.md");
    expect(include).toBeGreaterThanOrEqual(0);
    for (const dyn of [
      "{{ RESUME }}",
      "<commits>",
      "<learnings>",
      "<issues-summary>",
      "<issues-full-file>",
    ]) {
      expect(include).toBeLessThan(raw.indexOf(dyn));
    }
  });

  it("ghafk-issue.md puts the task header + workflow before the dynamic blocks", () => {
    const raw = tpl("ghafk-issue.md");
    const include = raw.indexOf("@include:ghprompt-workflow.md");
    expect(include).toBeGreaterThanOrEqual(0);
    for (const dyn of ["<commits>", "<learnings>", "<issue>"]) {
      expect(include).toBeLessThan(raw.indexOf(dyn));
    }
  });

  it("playbooks no longer claim the dynamic blocks are at the start of context", () => {
    for (const name of ["prompt.md", "ghprompt.md"]) {
      expect(tpl(name)).not.toContain("at the start of context");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- template-order`
Expected: FAIL — includes currently sit at the bottom of all three files.

- [ ] **Step 3: Reorder + fix positional wording**

`afk.md` after (full file; the `<learnings>` body is Task 3's):

```
@include:prompt.md

{{ RESUME }}

<commits>

!?`git log -n 5 --format="%H%n%ad%n%s---" --date=short|||No commits found`

</commits>

<learnings>

{{ LEARNINGS }}

</learnings>

<inputs>

{{ INPUTS }}

</inputs>
```

`ghafk.md` after (full file; the summary body is Task 4's):

```
@include:ghprompt.md

{{ RESUME }}

<commits>

!?`git log -n 5 --format="%H%n%ad%n%s---" --date=short|||No commits found`

</commits>

<learnings>

{{ LEARNINGS }}

</learnings>

<issues-summary>

!?`gh issue list ${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"} --state open --limit 50 --json number,title,labels --jq 'map({number: .number, title: .title, labels: [.labels[].name]})'|||[]`

</issues-summary>

<issues-full-file>

Full issue bodies + comments spilled to: @spill?:issues.json=`gh issue list ${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"} --state open --limit 50 --json number,title,body,labels,comments|||[]`

Read that file with `Read` (use `offset`/`limit` if it is large) to get bodies and comments before picking a task. The `<issues-summary>` block above is the lean index for triage.

@include:untrusted-content.md

</issues-full-file>
```

`ghafk-issue.md` after (full file; note the `(shown above)` → end-of-context rewording at old `:29`):

```
# THE TASK

Work **only** on issue #{{ INPUTS }} (shown in the `<issue>` block at the end of context). Do not list, triage, or pick from any other open issues — this run is scoped to a single issue.

If issue #{{ INPUTS }} is already complete (closed, or there is no work left to do), output <promise>NO MORE TASKS</promise>.

@include:ghprompt-workflow.md

<commits>

!?`git log -n 5 --format="%H%n%ad%n%s---" --date=short|||No commits found`

</commits>

<learnings>

{{ LEARNINGS }}

</learnings>

<issue>

!?`gh issue view "$OTTO_ISSUE" ${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"} --json number,title,state|||Issue not found`

Full issue body + comments spilled to: @spill?:issue.json=`gh issue view "$OTTO_ISSUE" ${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"} --json number,title,body,comments,state|||[]`

`Read` that file to get the full body and comments before acting on the issue.

If `$OTTO_GITHUB_REPO` is set (run scoped with `--repo owner/name`), pass `--repo "$OTTO_GITHUB_REPO"` to every `gh` command you run yourself (issue comment, pr create) so completion targets that repo. If unset, `gh` uses the workspace's own repo.

@include:untrusted-content.md

</issue>
```

`prompt.md:3` — before:

```
The plan and PRD are provided in the `<inputs>` block at the start of context — conventionally the paths to a plan file and a PRD file. `Read` them to get the work.
```

after:

```
The plan and PRD are provided in the `<inputs>` block at the end of context — conventionally the paths to a plan file and a PRD file. `Read` them to get the work.
```

`ghprompt.md:3` — before:

```
Two views of open GitHub issues are provided at the start of context:
```

after:

```
Two views of open GitHub issues are provided at the end of context:
```

`ghprompt.md:10` — before (first clause only; rest of the line unchanged):

```
**Repo scope.** If the `$OTTO_GITHUB_REPO` environment variable is set (the run was scoped with `--repo owner/name`), the issue list above is already confined to that repo — work only on those issues, and pass `--repo "$OTTO_GITHUB_REPO"` to every `gh` command you run yourself (e.g. `gh issue comment`, `gh pr create`) so completion targets the same repo. If it is unset, `gh` uses the workspace's own repo as before.
```

after:

```
**Repo scope.** If the `$OTTO_GITHUB_REPO` environment variable is set (the run was scoped with `--repo owner/name`), the issue list in `<issues-summary>` is already confined to that repo — work only on those issues, and pass `--repo "$OTTO_GITHUB_REPO"` to every `gh` command you run yourself (e.g. `gh issue comment`, `gh pr create`) so completion targets the same repo. If it is unset, `gh` uses the workspace's own repo as before.
```

(`ghafk.md:25`'s "block above" stays correct — the summary still precedes the full-file note; `governed-memory.md:34`'s "projection above" refers to its own prose, unaffected.)

- [ ] **Step 4: Run the template suites**

Run: `pnpm --filter @phamvuhoang/otto-core test -- template-order` then `pnpm --filter @phamvuhoang/otto-core test -- learnings` and `pnpm --filter @phamvuhoang/otto-core test -- ghafk-templates`
Expected: all PASS (the order-insensitive assertions of Tasks 3–4 hold on the reordered files).

- [ ] **Step 5: Commit**

```bash
pnpm -r typecheck
git add packages/core/templates/afk.md packages/core/templates/ghafk.md packages/core/templates/ghafk-issue.md packages/core/templates/prompt.md packages/core/templates/ghprompt.md packages/core/src/__tests__/template-order.test.ts
git commit -m "feat(p29): static-first entry templates for a cacheable prompt prefix"
```

---

### Task 7: Honest `--token-mode reduce` — wire `compactCommits`, drop the fake cache stats

**Files:**

- Modify: `packages/core/src/prompt-reduction.ts` (full rewrite below)
- Modify: `packages/core/src/stage-exec.ts` (stderr line at `:165-172`)
- Modify: `packages/core/src/__tests__/prompt-reduction.test.ts` (full replacement below)

**Interfaces:**

- Consumes: `parseCommitLog` (`iteration-compaction.ts:67`), `compactCommits` (`:93`), `formatCompactedCommits` (`:130`), `DEFAULT_COMMITS_BUDGET_CHARS = 2400` (`:49`) — the pure-then-wired substrate, wired at last.
- Produces:
  - `PromptReductionStats` becomes `{ originalChars: number; reducedChars: number; whitespaceSavedChars: number; commitsSavedChars: number }` — the hardcoded `cacheHits`/`cacheMisses` (`prompt-reduction.ts:33-34`) are gone (`prompt-reduction.ts` is not exported from `index.ts`, so the type change is repo-internal).
  - `applyPromptReduction(prompt)` compacts the rendered `<commits>` block when its parsed entries exceed the 2400-char budget (older entries degrade to subject-only with `formatCompactedCommits`' honest note), skipping the swap if it would not shrink the prompt; then compacts whitespace as before.

- [ ] **Step 1: Replace the test file**

```ts
// packages/core/src/__tests__/prompt-reduction.test.ts
import { describe, expect, it } from "vitest";

import { applyPromptReduction } from "../prompt-reduction.js";

// Valid parseCommitLog entries need a hex hash line, a date line, then the body.
function commitEntry(n: number, body: string): string {
  return `aaaaaa${n}\n2026-07-10\n${body}\n---`;
}

describe("applyPromptReduction", () => {
  it("compacts redundant blank lines and trailing spaces without removing sections", () => {
    const prompt = "<inputs>   \n\n\n\n\nRead ./full.txt   \n</inputs>\n";
    const reduced = applyPromptReduction(prompt);
    expect(reduced.prompt).toBe("<inputs>\n\n\nRead ./full.txt\n</inputs>\n");
    expect(reduced.stats.originalChars).toBe(prompt.length);
    expect(reduced.stats.reducedChars).toBeLessThan(prompt.length);
    expect(reduced.stats.whitespaceSavedChars).toBeGreaterThan(0);
    expect(reduced.stats.commitsSavedChars).toBe(0);
  });

  it("compacts an over-budget <commits> block to subject-only older entries", () => {
    const bigBody = `feat: change\n\n${"x".repeat(1200)}`;
    const block = [1, 2, 3].map((n) => commitEntry(n, bigBody)).join("\n");
    const prompt = `<commits>\n\n${block}\n\n</commits>\n`;
    const reduced = applyPromptReduction(prompt);
    expect(reduced.prompt).toContain("_Compacted: 2 older commit(s)");
    // The newest commit keeps its body; the two older ones degrade to subject.
    expect(reduced.prompt.match(/x{1200}/g)).toHaveLength(1);
    expect(
      reduced.prompt.match(/feat: change/g)!.length
    ).toBeGreaterThanOrEqual(3);
    expect(reduced.stats.commitsSavedChars).toBeGreaterThan(2000);
  });

  it("leaves an under-budget <commits> block untouched", () => {
    const prompt = `<commits>\n\n${commitEntry(1, "feat: small")}\n\n</commits>\n`;
    const reduced = applyPromptReduction(prompt);
    expect(reduced.prompt).toContain("feat: small");
    expect(reduced.prompt).not.toContain("_Compacted:");
    expect(reduced.stats.commitsSavedChars).toBe(0);
  });

  it("reports zero commit savings when there is no <commits> block", () => {
    expect(applyPromptReduction("x").stats.commitsSavedChars).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- prompt-reduction`
Expected: FAIL — `whitespaceSavedChars`/`commitsSavedChars` undefined; no compaction happens.

- [ ] **Step 3: Rewrite `prompt-reduction.ts`**

```ts
import {
  compactCommits,
  formatCompactedCommits,
  parseCommitLog,
} from "./iteration-compaction.js";

export type PromptReductionStats = {
  originalChars: number;
  reducedChars: number;
  /** Chars removed by whitespace compaction. */
  whitespaceSavedChars: number;
  /** Chars removed by degrading older <commits> entries to subject-only. */
  commitsSavedChars: number;
};

export type ReducedPrompt = {
  prompt: string;
  stats: PromptReductionStats;
};

function compactWhitespace(prompt: string): string {
  return prompt
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

const COMMITS_BLOCK = /<commits>\n+([\s\S]*?)\n+<\/commits>/;

/** Compact the rendered `<commits>` block via the P7 slice-6 substrate
 *  (iteration-compaction.ts), skipping the swap unless it actually shrinks. */
function compactCommitsBlock(prompt: string): {
  prompt: string;
  savedChars: number;
} {
  const m = COMMITS_BLOCK.exec(prompt);
  if (!m) return { prompt, savedChars: 0 };
  const compacted = compactCommits(parseCommitLog(m[1]));
  if (compacted.compacted.length === 0) return { prompt, savedChars: 0 };
  const replaced =
    prompt.slice(0, m.index) +
    `<commits>\n\n${formatCompactedCommits(compacted)}\n\n</commits>` +
    prompt.slice(m.index + m[0].length);
  if (replaced.length >= prompt.length) return { prompt, savedChars: 0 };
  return { prompt: replaced, savedChars: prompt.length - replaced.length };
}

/**
 * Conservative prompt reduction for `--token-mode reduce`. It never removes
 * semantic sections, source paths, spill references, or instructions; it
 * compacts whitespace and degrades older `<commits>` entries to their subject
 * line once the block exceeds its char budget — both reported honestly (P29
 * replaced the hardcoded cache stats this module used to fabricate).
 */
export function applyPromptReduction(prompt: string): ReducedPrompt {
  const afterCommits = compactCommitsBlock(prompt);
  const reduced = compactWhitespace(afterCommits.prompt);
  return {
    prompt: reduced,
    stats: {
      originalChars: prompt.length,
      reducedChars: reduced.length,
      whitespaceSavedChars: afterCommits.prompt.length - reduced.length,
      commitsSavedChars: afterCommits.savedChars,
    },
  };
}
```

In `stage-exec.ts` (`:165-172`), update the destructure + stderr line:

```ts
if (tokenMode === "reduce") {
  const reduced = applyPromptReduction(prompt);
  prompt = reduced.prompt;
  const {
    originalChars,
    reducedChars,
    whitespaceSavedChars,
    commitsSavedChars,
  } = reduced.stats;
  process.stderr.write(
    `${dim(`prompt reduce ${originalChars} -> ${reducedChars} chars | whitespace ${whitespaceSavedChars} | commits ${commitsSavedChars}`)}\n`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- prompt-reduction`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/prompt-reduction.ts packages/core/src/stage-exec.ts packages/core/src/__tests__/prompt-reduction.test.ts
git commit -m "feat(p29): token-mode reduce wires commit compaction and reports honest stats"
```

---

### Task 8: Diet-proof test + docs + roadmap status + full verify

**Files:**

- Test: `packages/core/src/__tests__/prompt-diet-proof.test.ts`
- Modify: `README.md` (learnings/`OTTO_UNBOUNDED_LEARNINGS` + honest `--token-mode reduce` blurbs), `docs/ARCHITECTURE.md` (`:302-313` — the `<issues-summary>` snippet showed a `!?` tag the template never had; update it to the real new tag), `docs/HARNESS_ROADMAP_PHASE6.md` (note under §P29 that the wiring slice landed)

**Interfaces:**

- Consumes: `renderTemplate`, `learningsForPrompt`, `writeMemoryRecord` (Task 1), `assessFactSurvival` (`compression-survival.ts:42` — the P22 survival gate, reused as the no-regression proof).

- [ ] **Step 1: Write the proof test** (CI-pure: render-level, no agent, no network)

````ts
// packages/core/src/__tests__/prompt-diet-proof.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";
import { assessFactSurvival } from "../compression-survival.js";
import {
  learningsForPrompt,
  writeMemoryRecord,
  type MemoryRecord,
} from "../memory.js";

const TEMPLATES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates"
);

// Load-bearing facts a diet must never drop (planted in high-relevance records).
const FACTS = [
  "pnpm --filter @app test -- --runInBand",
  "OTTO_RUNNER=sandbox",
  "packages/core/src/render.ts",
];

const rec = (
  id: string,
  content: string,
  confidence: number
): MemoryRecord => ({
  id,
  content,
  category: "convention",
  scope: [],
  confidence,
  trust: "trusted",
  status: "active",
  createdAt: "2026-07-01T00:00:00.000Z",
  useCount: 3,
});

function matureWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "otto-diet-"));
  mkdirSync(join(ws, ".otto"), { recursive: true });
  // A mature LEARNINGS.md, far over the 6000-char budget (~45k chars).
  const noise = Array.from(
    { length: 600 },
    (_, i) => `- low-value historical note ${i} ${"pad".repeat(20)}`
  ).join("\n");
  writeFileSync(
    join(ws, ".otto", "LEARNINGS.md"),
    `# Otto learnings\n\n## Conventions\n\n${noise}\n`,
    "utf8"
  );
  // High-relevance governed records carrying the facts…
  FACTS.forEach((fact, i) =>
    writeMemoryRecord(
      ws,
      rec(
        `2026-07-0${i + 1}T00-00-00-000Z-p29-${i}`,
        `Convention: ${fact}`,
        0.95
      )
    )
  );
  // …plus enough low-confidence noise records to overflow the budget.
  for (let i = 0; i < 40; i++) {
    writeMemoryRecord(
      ws,
      rec(
        `2026-06-01T00-00-00-000Z-noise-${String(i).padStart(2, "0")}`,
        `old noise ${i} ${"pad ".repeat(60)}`,
        0.4
      )
    );
  }
  return ws;
}

function renderAfk(ws: string, env: NodeJS.ProcessEnv): string {
  return renderTemplate(
    join(TEMPLATES, "afk.md"),
    {
      INPUTS: "plan",
      RESUME: "",
      LEARNINGS: learningsForPrompt(ws, {}, env).text,
    },
    { cwd: ws }
  );
}

describe("P29 prompt diet — proof on a mature fixture", () => {
  it("cuts the rendered afk prompt by at least 20% vs unbounded", () => {
    const ws = matureWorkspace();
    try {
      const bounded = renderAfk(ws, {});
      const unbounded = renderAfk(ws, { OTTO_UNBOUNDED_LEARNINGS: "1" });
      expect(bounded.length).toBeLessThanOrEqual(unbounded.length * 0.8);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("every planted load-bearing fact survives the bounded selection", () => {
    const ws = matureWorkspace();
    try {
      const survival = assessFactSurvival(
        FACTS,
        learningsForPrompt(ws, {}, {}).text
      );
      expect(survival.missing).toEqual([]);
      expect(survival.survivalRate).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a small-LEARNINGS repo is byte-identical to the old cat injection", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-diet-small-"));
    try {
      mkdirSync(join(ws, ".otto"), { recursive: true });
      writeFileSync(
        join(ws, ".otto", "LEARNINGS.md"),
        "## Gotchas\n- pnpm not npm\n",
        "utf8"
      );
      // Exactly what the `!?`cat``` tag injected: file content, trailing \n trimmed.
      expect(learningsForPrompt(ws, {}, {}).text).toBe(
        "## Gotchas\n- pnpm not npm"
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
````

- [ ] **Step 2: Run the proof**

Run: `pnpm --filter @phamvuhoang/otto-core test -- prompt-diet-proof`
Expected: PASS (3 tests) — the ≥20% drop comes from a ~45k-char learnings file collapsing to a ≤6k-char bounded block inside an ~18k-char static prompt.

- [ ] **Step 3: Docs**

- `README.md`: in the learnings/memory section, one short paragraph: entry prompts now inject a relevance-selected block bounded at 6000 chars once `LEARNINGS.md` outgrows it (small files are injected byte-identically; a file with no governed `.otto/memory/` records is never truncated); `OTTO_UNBOUNDED_LEARNINGS=1` restores whole-file injection. In the `--token-mode` flag description, state that `reduce` compacts whitespace and older `<commits>` entries and reports the real savings.
- `docs/ARCHITECTURE.md:302-313`: replace the illustrative `<issues-summary>` snippet with the actual new tag (`!?` + `--jq` label-name mapping + `|||[]`) — the old snippet documented an executed summary the template didn't have.
- `docs/HARNESS_ROADMAP_PHASE6.md`: under §P29's scope list, add a one-line status note that the bounded-injection/dedupe/cache-shape wiring landed (this plan), with live cache-read/eval confirmation as the operator follow-up.

- [ ] **Step 4: Full verify**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/__tests__/prompt-diet-proof.test.ts README.md docs/ARCHITECTURE.md docs/HARNESS_ROADMAP_PHASE6.md
git commit -m "feat(p29): diet proof (>=20% + fact survival + small-repo parity) and docs"
```

---

## Self-Review Notes

- **Spec-bullet → task mapping:** bounded `{{ LEARNINGS }}` resolution (spec decisions 1–3) = T1 (substrate) + T2 (wiring) + T3 (templates); ghafk lean executed summary (decision 4) = T4; shared panel diff spill (decision 5) = T5; static-first reorder + wording (decision 6) = T6; `memory-projection` fed at the var boundary (decision 7) = T2; honest `--token-mode reduce` (decision 8) = T7; success criteria 4 (≥20% + survival + parity proof) + docs = T8. Every in-scope spec bullet has a task; each out-of-scope bullet (seven remaining `cat` templates, review/verify/linear reorder, compressor into `runPanel`, `prior-iteration` category, live A/B) is deliberately absent.
- **Verified-source deviations baked in:** `ghafk.md`'s inline summary was found to be a _literal, never-executed_ backticked command already listing `number,title,labels` (no `!?` prefix; `docs/ARCHITECTURE.md` documents it as executed) — so T4 makes the lean index real rather than "shrinking a fat inline JSON dump"; and the "learnings flow through a spill" roadmap wording is implemented as `compressContentSync` at the `{{ LEARNINGS }}` var boundary (T2), because `@spill` substitutes file _paths_ while the `<learnings>` contract the playbooks reference requires inline text — same orchestrator, evidence record, and discard-unless-shrinks floor as spill compression.
- **Ordering:** T1 → T2 → T3 must land in that order (T3's templates render `{{ LEARNINGS }}`, which only `executeStage` supplies at runtime; T3's tests supply it explicitly). T4 is independent after T3 touches `ghafk.md` (both edit the file — apply sequentially). T5–T7 are independent of each other; T6 embeds T3/T4's edited blocks in its full-file snippets. T8 last.
- **Type consistency:** `LearningsResolution` (T1) consumed by T2/T8; `PreparedLearnings` (T2) internal to `stage-exec`; `PromptReductionStats`' new shape (T7) is repo-internal (`prompt-reduction.ts` is not exported from `index.ts`); `DIFF_FILE`/`LEARNINGS` are plain `RenderVars` strings, substituted by the existing last-pass generic tag (`render.ts:213`) — never re-shelled, so the render security invariant holds.
- **Behavior-change audit:** the only default change a user can observe is the bounded learnings block on repos whose `LEARNINGS.md` exceeds 6000 chars _and_ which have governed records — gated by byte parity below the budget, verbatim passthrough without records, the in-prompt omission note, the survival proof (T8), and `OTTO_UNBOUNDED_LEARNINGS=1`. Everything else preserves rendered-output semantics (same spill fallbacks, same block tags, same wire formats).
