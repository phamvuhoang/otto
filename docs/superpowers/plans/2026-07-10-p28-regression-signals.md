# P28 Regression Signals & Review Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed real signals — P27-attested check results and panel finding signatures — into the `deriveProgress`/`decide` machinery that already models them; make the review pipeline's bookkeeping stop disagreeing with itself (verdict-reconciled severity totals, post-synth confirmation, dirty-worktree refusal); and finish the half-populated evidence fields. Default runs (no checks config, no panel, no adaptive router) stay byte-for-byte unchanged.

**Architecture:** Pure signal helpers land first (`progress.ts`, `policy.ts`, `review-severity.ts`, new `finding-memory.ts`), each unit-tested in isolation. The panel (`panel.ts`) gains verdict-reconciled recording, a cheap-tier `review-confirm` local `Stage` const (house pattern: not in `STAGES`, run via `executeStage`), and a hard dirty-worktree refusal. The loop (`loop.ts`) wires the observations at its existing adaptive-control block (`:1538-1579`) and aggregates evidence onto the manifest. P27's contract (`checks.ts`) is consumed as given.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥20, vitest. `packages/core` only. No new npm dependencies.

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **No new npm dependencies.**
- **P27 first slice is a prerequisite.** `packages/core/src/checks.ts` must exist and export `ChecksRecord` + `summarizeChecks(records)` (contract: `{ command, exitCode, durationMs, outputTail, failureSignature, attestedAt }` / `{ passed, failed, failureSignatures }`), and `StageRecord.checks?: ChecksRecord[]` must be declared. Do not start this plan before that lands.
- **Opt-in-consistent.** No checks config ⇒ `failingChecks` stays `null`; no panel ⇒ `findingSignatures` stays `[]`; no adaptive router ⇒ `decide` is never consulted. Every new manifest/stage-record field is optional and absent by default.
- **No stash-and-restore.** The dirty-worktree decision is locked: refuse panel mode and fall back to the single reviewer. `git reset --hard` runs only from a tracked-clean baseline.
- **Verdict counts never drive fixes.** `parseVerdicts` feeds reporting and confirmation only; synth remains the authority on what it fixes (`panel.ts:113-114`).
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit runs prettier + typecheck.
- **Never hand-edit release version state.** release-please owns it.

---

### Task 1: Check-derived progress signals (`checkSignals` + `nextFailureStreak`)

**Files:**

- Modify: `packages/core/src/progress.ts` (append below `deriveProgress`)
- Modify: `packages/core/src/index.ts` (export from the existing `./progress.js` block at `:262-266`)
- Test: `packages/core/src/__tests__/check-signals.test.ts`

**Interfaces:**

- Consumes: **P27 contract** — `ChecksRecord`, `summarizeChecks(records: ChecksRecord[]): { passed: number; failed: number; failureSignatures: string[] }` from `./checks.js`.
- Produces:
  - `export type CheckSignals = { failingChecks: number | null; failureSignature: string | null };`
  - `export function checkSignals(records: ChecksRecord[] | null | undefined): CheckSignals` — no records ⇒ both `null` (unmeasured, today's behavior); else `failed` count + first failure signature (`null` when green).
  - `export function nextFailureStreak(prevSignature: string | null, curSignature: string | null, prevStreak: number): number` — `null` current ⇒ 0; repeat ⇒ `prevStreak + 1`; new signature ⇒ 1.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/check-signals.test.ts
import { describe, expect, it } from "vitest";
import { checkSignals, nextFailureStreak } from "../progress.js";
import type { ChecksRecord } from "../checks.js";

const rec = (over: Partial<ChecksRecord>): ChecksRecord => ({
  command: "pnpm -r test",
  exitCode: 0,
  durationMs: 1200,
  outputTail: "",
  failureSignature: null,
  attestedAt: "2026-07-10T00:00:00Z",
  ...over,
});

describe("checkSignals", () => {
  it("stays null/null when checks were not measured", () => {
    expect(checkSignals(null)).toEqual({
      failingChecks: null,
      failureSignature: null,
    });
    expect(checkSignals([])).toEqual({
      failingChecks: null,
      failureSignature: null,
    });
  });
  it("reports zero failing and no signature when everything passed", () => {
    expect(
      checkSignals([rec({}), rec({ command: "pnpm -r typecheck" })])
    ).toEqual({ failingChecks: 0, failureSignature: null });
  });
  it("reports the failed count and the dominant failure signature", () => {
    const s = checkSignals([
      rec({}),
      rec({ exitCode: 1, failureSignature: "vitest:panel.test.ts" }),
      rec({ exitCode: 1, failureSignature: "tsc:loop.ts" }),
    ]);
    expect(s.failingChecks).toBe(2);
    expect(s.failureSignature).toBe("vitest:panel.test.ts");
  });
});

describe("nextFailureStreak", () => {
  it("resets to zero when the current iteration has no failure", () => {
    expect(nextFailureStreak("sig-a", null, 2)).toBe(0);
  });
  it("starts a streak of one on a new signature", () => {
    expect(nextFailureStreak(null, "sig-a", 0)).toBe(1);
    expect(nextFailureStreak("sig-a", "sig-b", 3)).toBe(1);
  });
  it("increments when the same signature repeats", () => {
    expect(nextFailureStreak("sig-a", "sig-a", 1)).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- check-signals`
Expected: FAIL — `checkSignals` / `nextFailureStreak` not exported.

- [ ] **Step 3: Implement the helpers (pure)**

Append to `packages/core/src/progress.ts`:

```ts
import { summarizeChecks, type ChecksRecord } from "./checks.js";

/** The check-derived slice of an {@link IterationObservation} (P28): maps the
 * iteration's attested ChecksRecords (P27) into the observation's
 * failing-check count and dominant failure signature. No records ⇒ both null
 * ("not measured"), so runs without a checks config observe exactly what they
 * did before. Pure. */
export type CheckSignals = {
  failingChecks: number | null;
  failureSignature: string | null;
};

export function checkSignals(
  records: ChecksRecord[] | null | undefined
): CheckSignals {
  if (!records || records.length === 0) {
    return { failingChecks: null, failureSignature: null };
  }
  const summary = summarizeChecks(records);
  return {
    failingChecks: summary.failed,
    failureSignature: summary.failureSignatures[0] ?? null,
  };
}

/** Advance the cross-iteration repeated-failure streak (P28): the same
 * non-null signature two iterations running increments it; a new signature
 * restarts at 1; a green (null) iteration clears it. Pure. */
export function nextFailureStreak(
  prevSignature: string | null,
  curSignature: string | null,
  prevStreak: number
): number {
  if (curSignature == null) return 0;
  return curSignature === prevSignature ? prevStreak + 1 : 1;
}
```

(The `import` goes at the top of the file with the module's other imports; `progress.ts` currently has none, so add it as the first line after the module doc comment.) Export `checkSignals`, `nextFailureStreak`, and `type CheckSignals` from `index.ts`'s `./progress.js` block.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- check-signals`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/progress.ts packages/core/src/index.ts packages/core/src/__tests__/check-signals.test.ts
git commit -m "feat(p28): derive progress check signals from attested ChecksRecords"
```

---

### Task 2: Finding signatures + per-run finding memory

**Files:**

- Modify: `packages/core/src/review-severity.ts` (add `findingSignature` next to `dedupeFindings`, reusing `norm` at `:91`)
- Create: `packages/core/src/finding-memory.ts`
- Modify: `packages/core/src/index.ts` (export the new module's API)
- Test: `packages/core/src/__tests__/finding-memory.test.ts`

**Interfaces:**

- Consumes: `Finding`, `Severity`, the `norm` normalizer (`review-severity.ts:91`); `runReportDir(workspaceDir, runId)` (`run-report.ts:216`).
- Produces:
  - `export function findingSignature(f: Finding): string` — `` `${severity}|${file}|${norm(claim)}` `` (line numbers excluded on purpose: a fix that shifts lines must not mint a "new" finding).
  - `export type FindingMemoryEntry = { signature: string; severity: Severity; file: string; claim: string; iterations: number[] };`
  - `export type FindingMemory = { entries: FindingMemoryEntry[] };`
  - `export function recordFindings(memory: FindingMemory, iteration: number, findings: Finding[]): { memory: FindingMemory; recurring: FindingMemoryEntry[] }` — pure; `recurring` = entries seen in ≥2 distinct iterations after this recording.
  - `export function readFindingMemory(workspaceDir: string, runId: string): FindingMemory` / `export function writeFindingMemory(workspaceDir: string, runId: string, memory: FindingMemory): void` — `.otto/runs/<run-id>/findings.json`, throws-free both ways (absent/malformed ⇒ empty; write failures swallowed, mirroring `writeRunReport`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/finding-memory.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findingSignature, type Finding } from "../review-severity.js";
import {
  emptyFindingMemory,
  readFindingMemory,
  recordFindings,
  writeFindingMemory,
} from "../finding-memory.js";

const bug = (over: Partial<Finding> = {}): Finding => ({
  severity: "major",
  file: "src/loop.ts",
  line: "10",
  claim: "Missing  Rollback on retry",
  why: "w",
  ...over,
});

describe("findingSignature", () => {
  it("normalizes whitespace/case in the claim and ignores line numbers", () => {
    expect(findingSignature(bug())).toBe(
      "major|src/loop.ts|missing rollback on retry"
    );
    expect(findingSignature(bug({ line: "99" }))).toBe(findingSignature(bug()));
  });
});

describe("recordFindings", () => {
  it("first appearance is recorded but not recurring", () => {
    const r = recordFindings(emptyFindingMemory(), 1, [bug()]);
    expect(r.recurring).toEqual([]);
    expect(r.memory.entries[0].iterations).toEqual([1]);
  });
  it("a re-raise in a later iteration is flagged recurring with both iterations", () => {
    const first = recordFindings(emptyFindingMemory(), 1, [bug()]);
    const second = recordFindings(first.memory, 2, [bug({ line: "42" })]);
    expect(second.recurring).toHaveLength(1);
    expect(second.recurring[0].iterations).toEqual([1, 2]);
  });
  it("does not mutate its input and dedupes within one iteration", () => {
    const memory = emptyFindingMemory();
    const r = recordFindings(memory, 1, [bug(), bug()]);
    expect(memory.entries).toEqual([]);
    expect(r.memory.entries).toHaveLength(1);
    expect(r.recurring).toEqual([]); // same-iteration repeat is not a recurrence
  });
});

describe("read/write round-trip", () => {
  let ws: string;
  beforeEach(() => (ws = mkdtempSync(join(tmpdir(), "otto-fm-"))));
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("round-trips through .otto/runs/<run-id>/findings.json", () => {
    const { memory } = recordFindings(emptyFindingMemory(), 1, [bug()]);
    writeFindingMemory(ws, "rid", memory);
    expect(readFindingMemory(ws, "rid")).toEqual(memory);
  });
  it("absent or malformed file reads as empty (never throws)", () => {
    expect(readFindingMemory(ws, "nope")).toEqual({ entries: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- finding-memory`
Expected: FAIL — module not found / `findingSignature` not exported.

- [ ] **Step 3: Implement**

In `review-severity.ts`, after `dedupeFindings`:

```ts
/** Stable cross-iteration identity for a finding (P28): severity, file, and
 * the dedupe-normalized claim. Line numbers are excluded so a fix that shifts
 * code does not mint a "new" finding. */
export function findingSignature(f: Finding): string {
  return `${f.severity}|${f.file}|${norm(f.claim)}`;
}
```

Create `packages/core/src/finding-memory.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runReportDir } from "./run-report.js";
import {
  findingSignature,
  type Finding,
  type Severity,
} from "./review-severity.js";

/**
 * Cross-iteration finding memory (P28): per-run signatures of every finding
 * the review panel raised, persisted to `.otto/runs/<run-id>/findings.json`,
 * so a finding re-raised in a later iteration is flagged and counted instead
 * of silently re-entering the fix cycle. Recording is pure; the read/write
 * pair is throws-free (a bundle write must never break a run).
 */

export type FindingMemoryEntry = {
  signature: string;
  severity: Severity;
  file: string;
  claim: string;
  /** Distinct iterations (ascending) in which the panel raised this finding. */
  iterations: number[];
};

export type FindingMemory = { entries: FindingMemoryEntry[] };

export function emptyFindingMemory(): FindingMemory {
  return { entries: [] };
}

/** Fold one iteration's (deduped) findings into the memory. Pure — returns a
 * new memory plus the entries now seen in more than one iteration. */
export function recordFindings(
  memory: FindingMemory,
  iteration: number,
  findings: Finding[]
): { memory: FindingMemory; recurring: FindingMemoryEntry[] } {
  const entries = memory.entries.map((e) => ({
    ...e,
    iterations: [...e.iterations],
  }));
  const recurring: FindingMemoryEntry[] = [];
  for (const f of findings) {
    const signature = findingSignature(f);
    const hit = entries.find((e) => e.signature === signature);
    if (!hit) {
      entries.push({
        signature,
        severity: f.severity,
        file: f.file,
        claim: f.claim,
        iterations: [iteration],
      });
      continue;
    }
    if (!hit.iterations.includes(iteration)) hit.iterations.push(iteration);
    if (
      hit.iterations.length > 1 &&
      !recurring.some((r) => r.signature === signature)
    ) {
      recurring.push(hit);
    }
  }
  return { memory: { entries }, recurring };
}

const FINDINGS_FILE = "findings.json";

/** Read a run's finding memory. Absent/malformed → empty (never throws). */
export function readFindingMemory(
  workspaceDir: string,
  runId: string
): FindingMemory {
  try {
    const raw = JSON.parse(
      readFileSync(
        join(runReportDir(workspaceDir, runId), FINDINGS_FILE),
        "utf8"
      )
    ) as FindingMemory;
    if (raw && Array.isArray(raw.entries)) return raw;
  } catch {
    // absent or malformed → start fresh
  }
  return emptyFindingMemory();
}

/** Persist a run's finding memory. Best-effort — failures are swallowed. */
export function writeFindingMemory(
  workspaceDir: string,
  runId: string,
  memory: FindingMemory
): void {
  try {
    const p = join(runReportDir(workspaceDir, runId), FINDINGS_FILE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(memory, null, 2) + "\n");
  } catch {
    // Best-effort: never fail a run because finding memory could not persist.
  }
}
```

Export the module's four functions + two types from `index.ts` (new block next to the `./progress.js` exports). `findingSignature` is exported from `review-severity.ts` for internal reuse; `review-severity` has no `index.ts` block today — leave that surface as is.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- finding-memory`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/review-severity.ts packages/core/src/finding-memory.ts packages/core/src/index.ts packages/core/src/__tests__/finding-memory.test.ts
git commit -m "feat(p28): finding signatures + per-run cross-iteration finding memory"
```

---

### Task 3: Recurring-finding escalation rule in `decide`

**Files:**

- Modify: `packages/core/src/policy.ts` (`PolicyContext` at `:25-32`; `decide` at `:44`)
- Test: `packages/core/src/__tests__/regression-policy.test.ts`

**Interfaces:**

- Consumes: `ProgressSignals`, existing `decide` precedence (repeated failure ≻ confident finish ≻ stall ≻ continue).
- Produces: `PolicyContext.recurringFindingCount?: number` (optional — absent ⇒ 0 ⇒ today's behavior for all existing call sites). New rule, evaluated with escalate precedence directly after `repeatedFailureStreak`: any recurring finding ⇒ `escalate-pause` ("a fixed defect came back — a green check does not clear a re-raised review finding, so it outranks `finish-confident`").

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/regression-policy.test.ts
import { describe, expect, it } from "vitest";
import { decide } from "../policy.js";
import type { ProgressSignals } from "../progress.js";

const signals = (over: Partial<ProgressSignals> = {}): ProgressSignals => ({
  diffChanged: true,
  checksDelta: null,
  repeatedFailure: false,
  recurringFindings: [],
  costBurnRateUsd: 0.5,
  ...over,
});

describe("decide — recurring findings (P28)", () => {
  it("escalates to a human pause when a finding is re-raised after a fix cycle", () => {
    const d = decide(signals({ recurringFindings: ["major|src/a.ts|leak"] }), {
      stalledIterations: 0,
      repeatedFailureStreak: 0,
      failingChecks: 0,
      recurringFindingCount: 1,
    });
    expect(d.action).toBe("escalate-pause");
    expect(d.reason).toMatch(/re-raised/);
  });
  it("recurrence outranks a confident green finish", () => {
    const d = decide(signals(), {
      stalledIterations: 0,
      repeatedFailureStreak: 0,
      failingChecks: 0,
      recurringFindingCount: 2,
    });
    expect(d.action).toBe("escalate-pause");
  });
  it("absent recurringFindingCount keeps today's behavior", () => {
    const d = decide(signals(), {
      stalledIterations: 0,
      repeatedFailureStreak: 0,
      failingChecks: null,
    });
    expect(d.action).toBe("continue");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- regression-policy`
Expected: FAIL — first two tests get `finish-confident`/`continue` instead of `escalate-pause`.

- [ ] **Step 3: Implement**

In `PolicyContext`, add:

```ts
  /** Findings re-raised in a later iteration after a fix cycle (P28);
   *  absent/0 = none observed (today's behavior). */
  recurringFindingCount?: number;
```

In `decide`, after the `repeatedFailureStreak` guard and **before** the `failingChecks === 0` confident-finish guard:

```ts
const recurring = ctx.recurringFindingCount ?? 0;
if (recurring > 0) {
  return {
    action: "escalate-pause",
    reason: `${recurring} finding(s) re-raised after a fix cycle — human decision needed`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass (including the existing policy suite)**

Run: `pnpm --filter @phamvuhoang/otto-core test -- policy`
Expected: PASS — `regression-policy.test.ts` (3 tests) and the untouched `policy.test.ts`.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/policy.ts packages/core/src/__tests__/regression-policy.test.ts
git commit -m "feat(p28): escalate-pause on findings re-raised after a fix cycle"
```

---

### Task 4: Verdict parsing + verdict-reconciled panel recording

**Files:**

- Modify: `packages/core/src/review-severity.ts` (add `parseVerdicts` under `parseFindings`)
- Modify: `packages/core/src/run-report.ts` (add `StageRecord.reviewVerdicts` next to `reviewSeverity` at `:133-139`)
- Modify: `packages/core/src/panel.ts` (rework `readVerdicts` at `:115-127`; extend `RunPanelOptions.recordStage` at `:177-182`; record raw counts on the **verify** substage only, verdict counts on synth)
- Modify: `packages/core/src/loop.ts` (thread the new `extras` param through the `recordStage` closure at `:561-606` and the panel callback at `:1242-1243`)
- Test: `packages/core/src/__tests__/verdicts.test.ts`

**Interfaces:**

- Consumes: the verdict wire format from `templates/review-verify.md` — `CONFIRMED <severity> | file:line | claim | why` / `REJECTED | file:line | claim | why` / `none`; `parseFindings` (`review-severity.ts:30`).
- Produces:
  - `export type ReviewVerdicts = { confirmed: Finding[]; rejected: number; dropped: number };`
  - `export function parseVerdicts(text: string): ReviewVerdicts` — CONFIRMED lines re-parsed through `parseFindings` (so the verifier's severity downgrade is honored); REJECTED lines counted; `none`/prose ignored; malformed CONFIRMED lines counted as `dropped`.
  - `StageRecord.reviewVerdicts?: { confirmed: { blocker: number; major: number; minor: number; nit: number }; rejected: number };`
  - `RunPanelOptions.recordStage` gains an optional 5th param `extras?: { reviewVerdicts?: StageRecord["reviewVerdicts"]; reviewConfirmation?: StageRecord["reviewConfirmation"] }` (`reviewConfirmation` lands in Task 6; declare the field name now so the callback signature changes once).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/verdicts.test.ts
import { describe, expect, it } from "vitest";
import { parseVerdicts } from "../review-severity.js";

describe("parseVerdicts", () => {
  it("parses CONFIRMED lines with the verifier's (possibly downgraded) severity", () => {
    const v = parseVerdicts(
      [
        "CONFIRMED minor | src/a.ts:10 | leaky handle | verified against HEAD",
        "REJECTED | src/b.ts:2 | speculative | pre-existing",
        "CONFIRMED blocker | src/c.ts:1 | data loss | reproduced",
      ].join("\n")
    );
    expect(v.confirmed).toHaveLength(2);
    expect(v.confirmed[0].severity).toBe("minor");
    expect(v.confirmed[1].severity).toBe("blocker");
    expect(v.rejected).toBe(1);
    expect(v.dropped).toBe(0);
  });
  it("handles the no-findings sentinel and ignores prose", () => {
    const v = parseVerdicts("none\n\nSome explanation the agent added.\n");
    expect(v).toEqual({ confirmed: [], rejected: 0, dropped: 0 });
  });
  it("counts malformed CONFIRMED lines as dropped", () => {
    const v = parseVerdicts("CONFIRMED | src/a.ts:1 | no severity token\n");
    expect(v.confirmed).toEqual([]);
    expect(v.dropped).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- verdicts`
Expected: FAIL — `parseVerdicts` not exported.

- [ ] **Step 3: Implement `parseVerdicts`**

In `review-severity.ts`:

```ts
/** The verifier's verdicts.md, parsed (P28). CONFIRMED lines carry a severity
 * (the verifier may downgrade) and re-parse through {@link parseFindings};
 * REJECTED lines are counted; `none`/prose are ignored; malformed CONFIRMED
 * lines are counted as dropped. Reporting-and-confirmation input only — the
 * synth agent, not this parser, remains the authority on what gets fixed. */
export type ReviewVerdicts = {
  confirmed: Finding[];
  rejected: number;
  dropped: number;
};

export function parseVerdicts(text: string): ReviewVerdicts {
  const confirmed: Finding[] = [];
  let rejected = 0;
  let dropped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^none$/i.test(line)) continue;
    if (/^REJECTED\b/i.test(line)) {
      rejected++;
      continue;
    }
    const m = line.match(/^CONFIRMED\s+(.*)$/i);
    if (!m) continue; // prose, headers, tally lines
    const parsed = parseFindings(m[1]).findings;
    if (parsed.length === 1) confirmed.push(parsed[0]);
    else dropped++;
  }
  return { confirmed, rejected, dropped };
}
```

- [ ] **Step 4: Rework the panel recording**

In `run-report.ts`, after `reviewSeverity` (`:133-139`):

```ts
  /** Verifier-adjudicated verdict counts (P28); present on the panel's synth
   *  substage record only. `rejected` findings are excluded from confirmed
   *  totals — the report headlines these, not the raw lens counts. */
  reviewVerdicts?: {
    confirmed: { blocker: number; major: number; minor: number; nit: number };
    rejected: number;
  };
```

In `panel.ts`:

1. Import `parseVerdicts` from `./review-severity.js` and replace `readVerdicts` (keep the name/`exists` semantics):

```ts
type Verdicts = { exists: boolean; confirmed: Finding[]; rejected: number };
function readVerdicts(panelHostDir: string): Verdicts {
  try {
    const txt = readFileSync(join(panelHostDir, "verdicts.md"), "utf8");
    const v = parseVerdicts(txt);
    return { exists: true, confirmed: v.confirmed, rejected: v.rejected };
  } catch {
    return { exists: false, confirmed: [], rejected: 0 };
  }
}
```

Update the two display uses (`verdicts.confirmed` → `verdicts.confirmed.length`).

2. Extend the `recordStage` option type with the optional `extras` param (Interfaces above).

3. Fix the double count and attach verdicts: the verify record keeps `counts` (unchanged, `panel.ts:357`); the synth record (`panel.ts:419`) becomes:

```ts
const confirmedCounts = { blocker: 0, major: 0, minor: 0, nit: 0 };
for (const f of verdicts.confirmed) confirmedCounts[f.severity]++;
recordStage?.(SYNTH_STAGE.name, synth, synthStartedAt, undefined, {
  reviewVerdicts: {
    confirmed: confirmedCounts,
    rejected: verdicts.rejected,
  },
});
```

In `loop.ts`, extend the `recordStage` closure (`:561-606`) with the trailing optional param and spread it into the record:

```ts
    extras?: {
      reviewVerdicts?: StageRecord["reviewVerdicts"];
      reviewConfirmation?: StageRecord["reviewConfirmation"];
    }
    // ... in the writeStageRecord object:
    ...(extras?.reviewVerdicts ? { reviewVerdicts: extras.reviewVerdicts } : {}),
    ...(extras?.reviewConfirmation
      ? { reviewConfirmation: extras.reviewConfirmation }
      : {}),
```

(`reviewConfirmation` on `StageRecord` lands in Task 6 — until then reference only `reviewVerdicts` in the closure and add the second spread in Task 6, so each task typechecks.) Update the panel invocation callback (`:1242-1243`) to forward the fifth argument.

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `pnpm --filter @phamvuhoang/otto-core test -- verdicts panel`
Expected: PASS — new tests plus the existing `panel.test.ts` / `panel-wiring.test.ts` (the `recordStage` change is backward compatible; the verdict regex → parser swap keeps the confirmed/rejected display counts for well-formed fixtures).

```bash
pnpm -r typecheck
git add packages/core/src/review-severity.ts packages/core/src/run-report.ts packages/core/src/panel.ts packages/core/src/loop.ts packages/core/src/__tests__/verdicts.test.ts
git commit -m "feat(p28): parse verifier verdicts; record confirmed counts, un-double raw totals"
```

---

### Task 5: Report reconciliation — CONFIRMED headline, REJECTED separate

**Files:**

- Modify: `packages/core/src/report-finalize.ts` (`summarizeReviewSeverity` block at `:55-90`; evidence lines at `:168-173`; `buildFallbackRunReport` at `:273`)
- Test: `packages/core/src/__tests__/report-verdicts.test.ts`

**Interfaces:**

- Consumes: `StageRecord.reviewVerdicts` (Task 4), `summarizeReviewSeverity` (`:55-76`), `FinalizeReportContext`.
- Produces:
  - `export type ReviewVerdictSummary = { confirmed: { blocker: number; major: number; minor: number; nit: number }; rejected: number };`
  - `export function summarizeReviewVerdicts(stages: StageRecord[]): ReviewVerdictSummary | null` — sums `reviewVerdicts` across records; `null` when none (single-reviewer runs, panel-without-verdicts).
  - Headline behavior: when a verdict summary exists, the What To Watch risk note and the fallback report use confirmed totals with a "verifier-adjudicated" label and a separate rejected sentence; the evidence list carries both a `Review verdicts (verifier-adjudicated): …; rejected N (excluded from headline totals).` line and the raw counts relabeled `Review findings raised (pre-verification): …`. When absent, all existing text is byte-identical.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/report-verdicts.test.ts
import { describe, expect, it } from "vitest";
import {
  finalizeReportText,
  summarizeReviewVerdicts,
} from "../report-finalize.js";
import type { RunManifest, StageRecord } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

const stage = (over: Partial<StageRecord>): StageRecord => ({
  iteration: 1,
  stage: "review-verify",
  runtimeId: "claude",
  costUsd: 0.1,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-07-10T00:00:00Z",
  finishedAt: "2026-07-10T00:01:00Z",
  ...over,
});

const manifest: RunManifest = {
  runId: "rid",
  bin: "otto-afk",
  mode: "afk",
  inputs: "plan.md",
  runtime: { id: "claude", displayName: "Claude Code" },
  iterations: 1,
  costUsd: 0.1,
  tokenUsage: emptyTokenUsage(),
  artifacts: [],
  startedAt: "2026-07-10T00:00:00Z",
};

const panelStages: StageRecord[] = [
  stage({
    reviewSeverity: { blocker: 0, major: 3, minor: 1, nit: 0, suppressed: 0 },
  }),
  stage({
    stage: "review-synth",
    reviewVerdicts: {
      confirmed: { blocker: 0, major: 1, minor: 0, nit: 0 },
      rejected: 3,
    },
  }),
];

describe("summarizeReviewVerdicts", () => {
  it("sums verdict records and is null when none exist", () => {
    expect(summarizeReviewVerdicts(panelStages)).toEqual({
      confirmed: { blocker: 0, major: 1, minor: 0, nit: 0 },
      rejected: 3,
    });
    expect(summarizeReviewVerdicts([stage({})])).toBeNull();
  });
});

describe("finalizeReportText verdict reconciliation", () => {
  it("headlines confirmed totals, shows rejected separately, keeps raised as secondary", () => {
    const report = finalizeReportText(null, { manifest, stages: panelStages });
    expect(report).toMatch(/confirmed 0 blocker and 1 major/i);
    expect(report).toMatch(/rejected/i);
    expect(report).toMatch(/excluded from headline totals/i);
    expect(report).toMatch(/raised \(pre-verification\)/i);
  });
  it("without verdict records the severity text is unchanged", () => {
    const report = finalizeReportText(null, {
      manifest,
      stages: [
        stage({
          reviewSeverity: {
            blocker: 0,
            major: 1,
            minor: 0,
            nit: 2,
            suppressed: 2,
          },
        }),
      ],
    });
    expect(report).toMatch(/Review severity counts: blocker 0, major 1/);
    expect(report).not.toMatch(/verifier-adjudicated/i);
  });
});
```

(If `finalizeReportText`'s first parameter is typed `string` rather than `string | null`, pass `""` — it falls back to `buildFallbackRunReport` for empty input; match the real signature when writing the test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- report-verdicts`
Expected: FAIL — `summarizeReviewVerdicts` not exported.

- [ ] **Step 3: Implement**

In `report-finalize.ts`:

```ts
export type ReviewVerdictSummary = {
  confirmed: { blocker: number; major: number; minor: number; nit: number };
  rejected: number;
};

/** Sum verifier-adjudicated verdict counts across panel synth records (P28).
 * Null when the run recorded none — single-reviewer runs and panels whose
 * verifier wrote no verdicts keep today's raw-count reporting. */
export function summarizeReviewVerdicts(
  stages: StageRecord[]
): ReviewVerdictSummary | null {
  const summary: ReviewVerdictSummary = {
    confirmed: { blocker: 0, major: 0, minor: 0, nit: 0 },
    rejected: 0,
  };
  let seen = false;
  for (const stage of stages) {
    if (!stage.reviewVerdicts) continue;
    seen = true;
    summary.confirmed.blocker += stage.reviewVerdicts.confirmed.blocker;
    summary.confirmed.major += stage.reviewVerdicts.confirmed.major;
    summary.confirmed.minor += stage.reviewVerdicts.confirmed.minor;
    summary.confirmed.nit += stage.reviewVerdicts.confirmed.nit;
    summary.rejected += stage.reviewVerdicts.rejected;
  }
  return seen ? summary : null;
}

function verdictSentence(v: ReviewVerdictSummary): string {
  const rejectedNote =
    v.rejected > 0
      ? ` ${v.rejected} finding(s) were rejected by the verifier and are excluded from these totals.`
      : "";
  const high = v.confirmed.blocker + v.confirmed.major;
  if (high > 0) {
    return `Automated review confirmed ${v.confirmed.blocker} blocker and ${v.confirmed.major} major finding(s) (verifier-adjudicated); review the engineer evidence before accepting.${rejectedNote}`;
  }
  if (v.confirmed.minor + v.confirmed.nit > 0) {
    return `Automated review confirmed no blockers or major findings; ${v.confirmed.minor} minor and ${v.confirmed.nit} nit finding(s) were confirmed (verifier-adjudicated).${rejectedNote}`;
  }
  return `Automated review confirmed no findings (verifier-adjudicated).${rejectedNote}`;
}
```

Wire it into the three consumers, dispatching on `summarizeReviewVerdicts(ctx.stages)`:

- **Risk note** (`insertRiskNotes` call path) and **`buildFallbackRunReport`** (`:274,298`): use `verdictSentence(verdicts)` when non-null, else the existing `severitySentence(severity)`.
- **`automaticEvidenceLines`** (`:168-173`): when verdicts are non-null, push
  `- Review verdicts (verifier-adjudicated): confirmed blocker B, major M, minor Mi, nit N; rejected R (excluded from headline totals).`
  and relabel the raw line's prefix to `Review findings raised (pre-verification):`; when null, keep the exact `Review severity counts:` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- report-verdicts report-finalize`
Expected: PASS — new tests plus the untouched `report-finalize.test.ts` (its fixtures carry no `reviewVerdicts`, so output is unchanged).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/report-finalize.ts packages/core/src/__tests__/report-verdicts.test.ts
git commit -m "feat(p28): report headlines verifier-confirmed severity; rejected shown separately"
```

---

### Task 6: Post-synth confirmation substage

**Files:**

- Create: `packages/core/templates/review-confirm.md`
- Modify: `packages/core/src/review-severity.ts` (add `parseConfirmation`)
- Modify: `packages/core/src/run-report.ts` (add `StageRecord.reviewConfirmation`)
- Modify: `packages/core/src/panel.ts` (add `CONFIRM_STAGE` local const beside `SYNTH_STAGE` at `:94-98`; run it after synth; record + display)
- Modify: `packages/core/src/loop.ts` (add the `reviewConfirmation` spread in the `recordStage` closure — declared in Task 4)
- Modify: `packages/core/src/report-finalize.ts` (flag unaddressed CONFIRMED findings)
- Test: `packages/core/src/__tests__/review-confirm.test.ts`

**Interfaces:**

- Consumes: `Verdicts.confirmed` (Task 4), the LENS/VERIFY/SYNTH local-`Stage`-const house pattern (`panel.ts:84-98`), `tier: "cheap"` (`model-tier.ts:13`), `executeStage`, `trackedStatus`/`git`.
- Produces:
  - `const CONFIRM_STAGE: Stage = { name: "review-confirm", template: "review-confirm.md", permissionMode: "bypassPermissions", tier: "cheap" };` — **not** added to `STAGES` or any chain, per convention.
  - `export type ConfirmationResult = { addressed: number; unaddressed: { file: string; claim: string; note?: string }[] };`
  - `export function parseConfirmation(text: string): ConfirmationResult` (in `review-severity.ts`).
  - `StageRecord.reviewConfirmation?: ConfirmationResult`-shaped optional field.
  - Wire format: `ADDRESSED | file:line | claim` / `UNADDRESSED | file:line | claim | what is still missing`, tally `<confirm>A addressed, U unaddressed</confirm>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/review-confirm.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfirmation } from "../review-severity.js";
import { emptyTokenUsage } from "../tokens.js";

const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { runPanel } from "../panel.js";

describe("parseConfirmation", () => {
  it("counts addressed lines and structures unaddressed ones", () => {
    const c = parseConfirmation(
      [
        "ADDRESSED | src/a.ts:10 | leaky handle",
        "UNADDRESSED | src/b.ts:4 | missing rollback | fix commit never touched b.ts",
        "<confirm>1 addressed, 1 unaddressed</confirm>",
      ].join("\n")
    );
    expect(c.addressed).toBe(1);
    expect(c.unaddressed).toEqual([
      {
        file: "src/b.ts:4",
        claim: "missing rollback",
        note: "fix commit never touched b.ts",
      },
    ]);
  });
  it("empty/noise input yields a clean zero result", () => {
    expect(parseConfirmation("all good")).toEqual({
      addressed: 0,
      unaddressed: [],
    });
  });
});

const ok = (result: string, costUsd = 0) => ({
  result,
  costUsd,
  isError: false,
  apiErrorStatus: null,
  usage: emptyTokenUsage(),
});

const g = (ws: string, args: string[]) =>
  execFileSync("git", args, { cwd: ws }).toString().trim();

describe("runPanel post-synth confirmation", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "otto-confirm-"));
    g(ws, ["init", "-q"]);
    g(ws, ["config", "user.email", "t@t"]);
    g(ws, ["config", "user.name", "t"]);
    writeFileSync(join(ws, "a.ts"), "export const a = 1;\n");
    g(ws, ["add", "."]);
    g(ws, ["commit", "-qm", "base"]);
    mocks.executeStage.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  it("runs review-confirm after a synth commit and records unaddressed findings", async () => {
    mocks.executeStage.mockImplementation(
      (opts: {
        stage: { template: string };
        vars: { FINDINGS_DIR?: string };
      }) => {
        switch (opts.stage.template) {
          case "review-verify.md":
            writeFileSync(
              join(ws, opts.vars.FINDINGS_DIR!, "verdicts.md"),
              "CONFIRMED major | a.ts:1 | off by one | verified\n",
              "utf8"
            );
            return Promise.resolve(
              ok("<verify>1 confirmed, 0 rejected</verify>")
            );
          case "review-synth.md":
            writeFileSync(join(ws, "a.ts"), "export const a = 2;\n");
            g(ws, ["add", "."]);
            g(ws, ["commit", "-qm", "fix(review): off by one"]);
            return Promise.resolve(ok("fixed"));
          case "review-confirm.md":
            return Promise.resolve(
              ok(
                "UNADDRESSED | a.ts:1 | off by one | commit changed the wrong constant\n<confirm>0 addressed, 1 unaddressed</confirm>"
              )
            );
          default:
            return Promise.resolve(ok("major | a.ts:1 | off by one | why |"));
        }
      }
    );
    const recorded: { stage: string; extras?: unknown }[] = [];
    await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
      recordStage: (stage, _sr, _at, _sev, extras) =>
        recorded.push({ stage, extras }),
    });
    // 1 lens + verify + synth + confirm
    expect(mocks.executeStage).toHaveBeenCalledTimes(4);
    const confirm = recorded.find((r) => r.stage === "review-confirm");
    expect(confirm?.extras).toMatchObject({
      reviewConfirmation: {
        addressed: 0,
        unaddressed: [{ file: "a.ts:1", claim: "off by one" }],
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-confirm`
Expected: FAIL — `parseConfirmation` not exported; only 3 executeStage calls.

- [ ] **Step 3: Implement the template, parser, and panel wiring**

`packages/core/templates/review-confirm.md`:

```markdown
{{ RESUME }}

<verdicts>

The adversarial verifier's judgments — only `CONFIRMED` lines matter here:

!?`cat {{ FINDINGS_DIR }}verdicts.md|||none`

</verdicts>

<fix-commit>

!?`git show --stat HEAD|||No commit`

Full patch spilled to: @spill?:fix.diff=`git show HEAD|||No diff body`

Read that file with `Read` (use `offset`/`limit` for large diffs).

</fix-commit>

# POST-SYNTH CONFIRMATION

A synthesizer just committed `fix(review):` at HEAD claiming to address the
`CONFIRMED` findings above. Your only job: for each `CONFIRMED` finding, judge
whether the fix commit actually addresses it. Do not review for new defects,
do not re-litigate the verdicts, do not suggest improvements.

# OUTPUT

One line per `CONFIRMED` finding:

- `ADDRESSED | file:line | claim`
- `UNADDRESSED | file:line | claim | what is still missing`

If there are no `CONFIRMED` findings, output nothing but the tally. End your
reply with a one-line tally: `<confirm>A addressed, U unaddressed</confirm>`.

# RULES

- READ-ONLY. Do not edit files. Do not commit. Do not run feedback loops.
- A finding is ADDRESSED only if the diff plausibly fixes the specific claim —
  a nearby unrelated change does not count.
```

In `review-severity.ts`:

```ts
/** The post-synth confirmation substage's output, parsed (P28): whether each
 * verifier-CONFIRMED finding was actually addressed by the fix(review:)
 * commit. Evidence-only — unaddressed findings are flagged in the report, not
 * auto-fixed. */
export type ConfirmationResult = {
  addressed: number;
  unaddressed: { file: string; claim: string; note?: string }[];
};

export function parseConfirmation(text: string): ConfirmationResult {
  const out: ConfirmationResult = { addressed: 0, unaddressed: [] };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^ADDRESSED\s*\|/i.test(line)) {
      out.addressed++;
      continue;
    }
    const m = line.match(/^UNADDRESSED\s*\|([^|]*)\|([^|]*)(?:\|(.*))?$/i);
    if (!m) continue;
    const note = m[3]?.trim();
    out.unaddressed.push({
      file: m[1].trim(),
      claim: m[2].trim(),
      ...(note ? { note } : {}),
    });
  }
  return out;
}
```

In `run-report.ts`, after `reviewVerdicts`:

```ts
  /** Post-synth confirmation outcome (P28); present on the review-confirm
   *  substage record only. Unaddressed CONFIRMED findings are report risks. */
  reviewConfirmation?: {
    addressed: number;
    unaddressed: { file: string; claim: string; note?: string }[];
  };
```

In `panel.ts`, beside `SYNTH_STAGE`:

```ts
// Post-synth confirmation (P28): a cheap, read-only pass that diffs the synth
// commit against the CONFIRMED findings. Harness-orchestrated local Stage —
// not in STAGES or any chain (house convention, like the lens/verify/synth
// consts above).
const CONFIRM_STAGE: Stage = {
  name: "review-confirm",
  template: "review-confirm.md",
  permissionMode: "bypassPermissions",
  tier: "cheap",
};
```

After the synth outcome block (`panel.ts:404-418`), replace the tail
`recordStage?.(SYNTH_STAGE.name, …); onStage?.(synth); return synth;` with:

```ts
recordStage?.(SYNTH_STAGE.name, synth, synthStartedAt, undefined, {
  reviewVerdicts: { confirmed: confirmedCounts, rejected: verdicts.rejected },
});
const sctrl = onStage?.(synth) ?? { stop: false, cooldownFactor: 1 };

// 4. Post-synth confirmation (P28) — only when there is something to
//    confirm: a real fix commit and ≥1 CONFIRMED finding. Evidence-only;
//    the synth result remains the panel's return value.
if (committed && verdicts.confirmed.length > 0 && !sctrl.stop) {
  phaseLine("post-synth confirmation");
  const confirmBase = git(["rev-parse", "HEAD"], workspaceDir);
  const confirmClean = trackedStatus(workspaceDir) === "";
  const confirmStartedAt = isoNow();
  const confirm = await executeStage({
    stage: CONFIRM_STAGE,
    vars: { FINDINGS_DIR: findingsDirRef, RESUME: resumeNote },
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    tokenMode,
    signal,
    agentId,
    logLabel: "confirm",
    modelRouting: opts.modelRouting,
    tierLadder: opts.tierLadder,
    riskAssessment: opts.riskAssessment,
  });
  // Read-only guard from the *post-synth* baseline (baseHead moved when
  // synth committed): only enforce from a tracked-clean snapshot.
  if (
    confirmClean &&
    confirmBase != null &&
    (git(["rev-parse", "HEAD"], workspaceDir) !== confirmBase ||
      trackedStatus(workspaceDir) !== "")
  ) {
    process.stderr.write(
      `${red(SYM.cross)} ${dim(`review-confirm mutated the repo (read-only violation) — restoring to ${confirmBase.slice(0, 8)}`)}\n`
    );
    git(["reset", "--hard", confirmBase], workspaceDir);
  }
  const confirmation = parseConfirmation(confirm.result);
  outcomeLine(
    confirmation.unaddressed.length === 0
      ? `${confirmation.addressed} confirmed finding(s) addressed`
      : `${confirmation.unaddressed.length} CONFIRMED finding(s) unaddressed`,
    confirmation.unaddressed.length === 0
  );
  recordStage?.(CONFIRM_STAGE.name, confirm, confirmStartedAt, undefined, {
    reviewConfirmation: confirmation,
  });
  onStage?.(confirm);
}
return synth;
```

In `loop.ts`, add the `reviewConfirmation` spread to the `recordStage` closure (declared in Task 4). In `report-finalize.ts`, add a `summarizeReviewConfirmation(stages)` helper (same shape/pattern as `summarizeReviewVerdicts`, summing `addressed` and concatenating `unaddressed`) and, when any `unaddressed` exist, insert a What To Watch note — `Post-synth confirmation flagged N CONFIRMED finding(s) not addressed by the fix commit: file — claim; …` — plus a matching Automated Evidence line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-confirm panel report`
Expected: PASS — new tests; existing panel tests unaffected (their non-git workspaces never satisfy `committed`, so no confirm substage spawns).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/templates/review-confirm.md packages/core/src/review-severity.ts packages/core/src/run-report.ts packages/core/src/panel.ts packages/core/src/loop.ts packages/core/src/report-finalize.ts packages/core/src/__tests__/review-confirm.test.ts
git commit -m "feat(p28): cheap-tier post-synth confirmation of CONFIRMED findings"
```

---

### Task 7: Dirty-worktree panel refusal + read-only-violation safety events

**Files:**

- Modify: `packages/core/src/panel.ts` (export `panelRefusalReason`; hard-refuse in `runPanel`, deleting the warn-and-continue branch at `:233-239`; emit a `SafetyEvent` from `restoreIfMutated`)
- Modify: `packages/core/src/loop.ts` (check refusal before invoking the panel at `:1221-1244`; fall back to the single reviewer; record a run-level `SafetyEvent`)
- Test: `packages/core/src/__tests__/panel-refusal.test.ts`

**Interfaces:**

- Consumes: `trackedStatus` (`panel.ts:186-188`), `git`, `SafetyEvent` (`run-report.ts:33-47`, kinds from `safety-policy.ts:83`), the manifest safety-events merge (`loop.ts:889-891`).
- Produces:
  - `export function panelRefusalReason(workspaceDir: string): string | null` — `null` outside a git repo (nothing to protect; keeps today's test workspaces working) and on a tracked-clean tree; a reason string when tracked changes exist.
  - `runPanel` refusal: synthetic non-error `StageResult` `"<review>SKIPPED — panel refused: uncommitted tracked changes</review>"`, no sub-agent spawned.
  - `restoreIfMutated` returns as before but now also appends `{ category: "policy-violation", kind: "write-root", subject: who, message: "…read-only violation — restored to <sha>", blocked: true }` to the offending substage's `sr.safetyEvents` (thread by attaching before `recordStage` is called for that substage; for the batched lens reset, attach to each lens result recorded after the reset).
  - Loop fallback: when `panelRefusalReason` is non-null, warn `↳ panel refused: … — falling back to single reviewer` and run the plain reviewer stage; push the same-shaped event (subject `"review-panel"`, `blocked: true`) onto the run-level safety-events array merged into the manifest (rename the local `compressorSafetyEvents` at `loop.ts:520` to `runSafetyEvents` — it now has two producers).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/panel-refusal.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { panelRefusalReason, runPanel } from "../panel.js";

const g = (ws: string, args: string[]) =>
  execFileSync("git", args, { cwd: ws }).toString().trim();

describe("panel dirty-worktree refusal", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "otto-refuse-"));
    mocks.executeStage.mockReset();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  it("panelRefusalReason is null outside a repo and on a clean tree", () => {
    expect(panelRefusalReason(ws)).toBeNull(); // not a repo
    g(ws, ["init", "-q"]);
    g(ws, ["config", "user.email", "t@t"]);
    g(ws, ["config", "user.name", "t"]);
    writeFileSync(join(ws, "a.ts"), "1\n");
    g(ws, ["add", "."]);
    g(ws, ["commit", "-qm", "base"]);
    expect(panelRefusalReason(ws)).toBeNull(); // clean
    writeFileSync(join(ws, "a.ts"), "2\n");
    expect(panelRefusalReason(ws)).toMatch(/uncommitted tracked changes/);
  });

  it("runPanel refuses on a dirty tree: no sub-agent spawns, synthetic result", async () => {
    g(ws, ["init", "-q"]);
    g(ws, ["config", "user.email", "t@t"]);
    g(ws, ["config", "user.name", "t"]);
    writeFileSync(join(ws, "a.ts"), "1\n");
    g(ws, ["add", "."]);
    g(ws, ["commit", "-qm", "base"]);
    writeFileSync(join(ws, "a.ts"), "2\n"); // dirty tracked edit
    const out = await runPanel({
      lenses: ["correctness"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 0,
    });
    expect(mocks.executeStage).not.toHaveBeenCalled();
    expect(out.isError).toBe(false);
    expect(out.result).toMatch(/panel refused/i);
    expect(g(ws, ["status", "--porcelain"])).not.toBe(""); // user state untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- panel-refusal`
Expected: FAIL — `panelRefusalReason` not exported; `runPanel` spawns lenses on the dirty tree.

- [ ] **Step 3: Implement**

In `panel.ts`:

```ts
/** Why panel mode must refuse to run, or null when it can (P28). Panel lenses
 * are contractually read-only and the reset guard can only enforce that from
 * a tracked-clean baseline — so uncommitted tracked changes mean refusal (the
 * loop falls back to the single reviewer), never warn-and-continue. Outside a
 * git repo there is nothing to protect. */
export function panelRefusalReason(workspaceDir: string): string | null {
  if (git(["rev-parse", "HEAD"], workspaceDir) == null) return null;
  const status = trackedStatus(workspaceDir);
  if (status == null || status === "") return null;
  return "uncommitted tracked changes in the worktree";
}
```

At the top of `runPanel` (before the temp dir is created):

```ts
const refusal = panelRefusalReason(workspaceDir);
if (refusal) {
  process.stderr.write(
    `${red(SYM.cross)} ${dim(`${refusal} — panel refused (read-only lens enforcement would be unsafe); commit or stash first`)}\n`
  );
  return {
    result:
      "<review>SKIPPED — panel refused: uncommitted tracked changes</review>",
    costUsd: 0,
    isError: false,
    apiErrorStatus: null,
    usage: emptyTokenUsage(),
    runtimeId: agentId ?? DEFAULT_AGENT,
  };
}
```

Then simplify the guard: `enforceReadOnly` becomes `baseHead != null` and the warn-and-continue branch (`:235-239`) is deleted — refusal guarantees the tracked-clean precondition. In `restoreIfMutated`, after the reset, build the event and attach it to the substage result recorded next (pass the event back to the call sites: `restoreIfMutated` returns the event or `null` instead of a boolean, and the lens/verify call sites append it to `sr.safetyEvents` before `recordStage` runs).

In `loop.ts`:

1. Rename `compressorSafetyEvents` → `runSafetyEvents` (declaration at `:520`, assignment at `:533`, manifest merge at `:889-891`).
2. In `runOnce` (`:1220-1245`), gate the panel:

```ts
if (usePanel) {
  const { runPanel, panelRefusalReason } = await import("./panel.js");
  const refusal = panelRefusalReason(workspaceDir);
  if (refusal) {
    process.stderr.write(
      `${dim(`↳ panel refused: ${refusal} — falling back to single reviewer`)}\n`
    );
    runSafetyEvents.push({
      category: "policy-violation",
      kind: "write-root",
      subject: "review-panel",
      message: `panel refused: ${refusal}; fell back to single reviewer`,
      blocked: true,
    });
  } else {
    return runPanel({
      /* existing options unchanged */
    });
  }
}
// …existing single-agent path (now also the refusal fallback)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- panel`
Expected: PASS — `panel-refusal.test.ts`, plus `panel.test.ts`/`review-confirm.test.ts` (non-git and clean-repo workspaces are unaffected by the refusal gate).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/panel.ts packages/core/src/loop.ts packages/core/src/__tests__/panel-refusal.test.ts
git commit -m "feat(p28): refuse panel on dirty worktree; record read-only violations as safety events"
```

---

### Task 8: Loop wiring, recurring-defect fixture, evidence completion, docs

**Files:**

- Modify: `packages/core/src/loop.ts` (observation wiring at `:1538-1579`; state near `:971-972`; `recordStage` closure; manifest at `:874-907`)
- Modify: `packages/core/src/panel.ts` (add `RunPanelOptions.onFindings` callback)
- Modify: `packages/core/src/run-report.ts` (add `RunManifest.findingRecurrence`; refresh the stale "no bin/loop populates them yet" comments on `SafetyEvent` at `:29-32` and `ToolUsage` at `:80-84`)
- Modify: `packages/core/src/report-finalize.ts` (recurrence note from the manifest)
- Modify: `README.md` (review panel / adaptive router sections), `docs/HARNESS_ROADMAP_PHASE6.md` (§P28 status note)
- Test: `packages/core/src/__tests__/regression-trajectory.test.ts`

**Interfaces:**

- Consumes: **P27 contract** — `ChecksRecord` and the loop's attestation call site (P27's first slice runs checks after fix commits and attaches `StageRecord.checks`); Tasks 1–3 helpers; `deriveProgress`/`decide`; `Finding`.
- Produces:
  - `RunPanelOptions.onFindings?: (findings: Finding[]) => void` — invoked once per panel run with the merged, deduped lens findings (right after `mergeLensFindings`, `panel.ts:317-319`); absent ⇒ no behavior change.
  - `RunManifest.findingRecurrence?: { signature: string; severity: string; file: string; claim: string; iterations: number[] }[]` (structural type — no import cycle; absent when nothing recurred).
  - Loop state: `iterationChecks: ChecksRecord[] | null`, `iterationFindingSignatures: string[]`, `recurringFindingCount: number` (reset each iteration), `prevFailureSignature`/`repeatedFailureStreak` (cross-iteration), `runToolsUsed: ToolUsage[]`, `runRecurrence: Map<string, FindingMemoryEntry>`, `findingMemory` (loaded once per run).

- [ ] **Step 1: Write the failing test — the recurring-defect fixture (roadmap success metric)**

```ts
// packages/core/src/__tests__/regression-trajectory.test.ts
import { describe, expect, it } from "vitest";
import {
  checkSignals,
  deriveProgress,
  nextFailureStreak,
  type IterationObservation,
} from "../progress.js";
import { decide } from "../policy.js";
import { emptyFindingMemory, recordFindings } from "../finding-memory.js";
import type { Finding } from "../review-severity.js";
import type { ChecksRecord } from "../checks.js";

const defect: Finding = {
  severity: "major",
  file: "src/loop.ts",
  claim: "missing rollback on retry",
  why: "w",
};

const failing: ChecksRecord = {
  command: "pnpm -r test",
  exitCode: 1,
  durationMs: 900,
  outputTail: "1 failed",
  failureSignature: "vitest:loop.test.ts",
  attestedAt: "2026-07-10T00:00:00Z",
};

function observe(
  iteration: number,
  checks: ChecksRecord[] | null,
  findingSignatures: string[]
): IterationObservation {
  return {
    diffSignature: `diff-${iteration}`,
    ...checkSignals(checks),
    findingSignatures,
    cumulativeCostUsd: iteration,
  };
}

describe("recurring-defect trajectory (P28 roadmap fixture)", () => {
  it("escalates within one iteration of a finding's second appearance", () => {
    // Iteration 1: the panel raises the defect; first appearance — continue.
    let memory = emptyFindingMemory();
    const first = recordFindings(memory, 1, [defect]);
    memory = first.memory;
    const obs1 = observe(
      1,
      null,
      first.memory.entries.map((e) => e.signature)
    );
    const d1 = decide(deriveProgress(obs1, null), {
      stalledIterations: 0,
      repeatedFailureStreak: 0,
      failingChecks: null,
      recurringFindingCount: first.recurring.length,
    });
    expect(d1.action).toBe("continue");

    // Iteration 2: synth "fixed" it, the panel raises it again — escalate now.
    const second = recordFindings(memory, 2, [defect]);
    const obs2 = observe(
      2,
      null,
      second.memory.entries.map((e) => e.signature)
    );
    const d2 = decide(deriveProgress(obs2, obs1), {
      stalledIterations: 0,
      repeatedFailureStreak: 0,
      failingChecks: null,
      recurringFindingCount: second.recurring.length,
    });
    expect(d2.action).toBe("escalate-pause");
    expect(d2.reason).toMatch(/re-raised/);
  });

  it("a repeated attested failure signature escalates at the existing threshold", () => {
    let streak = 0;
    let prevSig: string | null = null;
    let prev: IterationObservation | null = null;
    let action = "continue";
    for (let i = 1; i <= 3; i++) {
      const obs = observe(i, [failing], []);
      streak = nextFailureStreak(prevSig, obs.failureSignature, streak);
      prevSig = obs.failureSignature;
      action = decide(deriveProgress(obs, prev), {
        stalledIterations: 0,
        repeatedFailureStreak: streak,
        failingChecks: obs.failingChecks,
      }).action;
      prev = obs;
    }
    expect(streak).toBe(3);
    expect(action).toBe("escalate-pause");
  });

  it("no checks config and no panel observes exactly what today's loop hardcodes", () => {
    const obs = observe(1, null, []);
    expect(obs.failingChecks).toBeNull();
    expect(obs.failureSignature).toBeNull();
    expect(obs.findingSignatures).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then passes once green**

Run: `pnpm --filter @phamvuhoang/otto-core test -- regression-trajectory`
Expected: PASS immediately if Tasks 1–3 are complete (this is the integration fixture over their pure seams). If it fails, fix the seam it names before wiring the loop.

- [ ] **Step 3: Wire the loop**

In `loop.ts` (imports: `checkSignals`, `nextFailureStreak` from `./progress.js`; `readFindingMemory`, `recordFindings`, `writeFindingMemory`, `type FindingMemoryEntry` from `./finding-memory.js`; `findingSignature`, `type Finding` from `./review-severity.js`; `type ChecksRecord` from `./checks.js`):

1. **State** — beside `prevObservation`/`stalledIterations` (`:971-972`):

```ts
let prevFailureSignature: string | null = null;
let repeatedFailureStreak = 0;
let iterationChecks: ChecksRecord[] | null = null;
let iterationFindingSignatures: string[] = [];
let recurringFindingCount = 0;
let findingMemory = readFindingMemory(workspaceDir, runId);
const runRecurrence = new Map<string, FindingMemoryEntry>();
```

Also update the now-stale comment at `:967-970` ("failing-check and failure-signature observability is future work") — it is no longer future work. Reset `iterationChecks`/`iterationFindingSignatures`/`recurringFindingCount` at the top of each iteration body.

2. **Checks capture (P27 integration point).** P27's first slice invokes its attestation runner from the loop after fix commits and attaches `checks` to the stage record. At that call site, also assign the returned records: `iterationChecks = records;`. Locate it with `grep -n "ChecksRecord\|runChecks\|attest" packages/core/src/loop.ts`; if P27 landed the capture under a different local name, adapt to it — the tested surface is `checkSignals`, not the variable name.

3. **Findings capture** — in `panel.ts`, add to `RunPanelOptions`:

```ts
  /** Called once with the merged, deduped lens findings (P28) so the loop can
   *  feed finding signatures into progress observation + finding memory.
   *  Absent ⇒ no behavior change. */
  onFindings?: (findings: Finding[]) => void;
```

Invoke `opts.onFindings?.(findings);` immediately after `mergeLensFindings` (`panel.ts:317-319`, before the zero-findings early return so an empty raise is also observed). In the loop's `runPanel` invocation (`:1223-1244`), pass:

```ts
              onFindings: (findings) => {
                iterationFindingSignatures = findings.map(findingSignature);
                const rec = recordFindings(findingMemory, i, findings);
                findingMemory = rec.memory;
                recurringFindingCount = rec.recurring.length;
                for (const e of rec.recurring) runRecurrence.set(e.signature, e);
                writeFindingMemory(workspaceDir, runId, findingMemory);
                if (rec.recurring.length > 0) {
                  process.stderr.write(
                    `${dim(`↳ ${rec.recurring.length} finding(s) re-raised from an earlier iteration`)}\n`
                  );
                }
              },
```

4. **Observation + decision** — replace the hardcoded fields (`:1542-1548`) and the `decide` context (`:1553-1557`):

```ts
const checks = checkSignals(iterationChecks);
const cur: IterationObservation = {
  diffSignature: [...iterChanged].sort().join("|"),
  failingChecks: checks.failingChecks,
  failureSignature: checks.failureSignature,
  findingSignatures: iterationFindingSignatures,
  cumulativeCostUsd: runCostUsd,
};
repeatedFailureStreak = nextFailureStreak(
  prevFailureSignature,
  checks.failureSignature,
  repeatedFailureStreak
);
prevFailureSignature = checks.failureSignature;
// …deriveProgress unchanged…
const decision = decide(signals, {
  stalledIterations,
  repeatedFailureStreak,
  failingChecks: checks.failingChecks,
  recurringFindingCount,
});
```

5. **Evidence completion** — in the `recordStage` closure add `if (sr.toolsUsed?.length) runToolsUsed.push(...sr.toolsUsed);` (declare `const runToolsUsed: ToolUsage[] = [];` beside `runSkillsUsed` at `:615`); in the manifest write (`:874-907`) add:

```ts
        ...(runToolsUsed.length > 0 ? { toolsUsed: runToolsUsed } : {}),
        ...(runRecurrence.size > 0
          ? { findingRecurrence: [...runRecurrence.values()] }
          : {}),
```

In `run-report.ts`: add the `findingRecurrence` optional field to `RunManifest` (structural type per Interfaces), and rewrite the stale INERT paragraphs — `SafetyEvent` (`:29-32`) and `ToolUsage` (`:80-84`) are populated by the render boundary/compressor (`stage-exec.ts:217-220`), panel guards (P28), and the manifest aggregation (P28); say so instead of "no bin/loop populates them yet".

6. **Report recurrence note** — in `report-finalize.ts`, when `ctx.manifest.findingRecurrence?.length`, add a What To Watch note (`Automated risk note: N finding(s) were re-raised after an earlier fix cycle — see findingRecurrence in the manifest.`) and an Automated Evidence line listing each `signature (iterations i, j)`. Extend `report-verdicts.test.ts` or the trajectory test with one assertion over `finalizeReportText` for this note.

7. **Docs** — `README.md`: document the panel's dirty-worktree refusal, post-synth confirmation, verdict-reconciled report totals, and that `--adaptive-router` now consumes attested checks + finding recurrence when their producers are configured. `docs/HARNESS_ROADMAP_PHASE6.md`: add a status note under §P28 that the slice has landed.

- [ ] **Step 4: Full verify**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop.ts packages/core/src/panel.ts packages/core/src/run-report.ts packages/core/src/report-finalize.ts packages/core/src/__tests__/regression-trajectory.test.ts README.md docs/HARNESS_ROADMAP_PHASE6.md
git commit -m "feat(p28): wire attested checks + finding recurrence into adaptive iteration control"
```

---

## Self-Review Notes

- **Spec coverage:** wire the inert signals (T1 pure derivation, T8 loop wiring); cross-iteration finding memory (T2 memory, T3 policy rule, T8 persistence + manifest `findingRecurrence` + report note); reconcile `reviewSeverity` (T4 parsing/recording + double-count fix, T5 report headline); post-synth confirmation (T6); panel read-only hardening (T7); `toolsUsed`/`safetyEvents` completion (T7 violation events, T8 manifest aggregation + stale-comment fixes). All six spec scope bullets map to tasks; the recurring-defect, severity-match, skipped-CONFIRMED, and dirty-worktree success criteria are asserted in T8/T5/T6/T7 tests respectively.
- **P27 contract:** consumed as given (`ChecksRecord`/`summarizeChecks` from `./checks.js`) in T1 and T8; T8 step 3.2 is the single integration point with P27's loop-side attestation call and is deliberately described by intent + a grep, since P27's exact local naming is landing in parallel — the tested surface (`checkSignals`) does not depend on it.
- **Deviations from the audit brief:** (1) `decide` lives in `policy.ts:44`, not `progress.ts` — citations corrected. (2) `toolsUsed`/`safetyEvents` are _not_ fully inert: `stage-exec.ts:217-220` + `loop.ts:593-595` already populate stage records on the render/compressor path; the genuinely dead surface is the manifest `toolsUsed` field and the missing panel-guard events, so the plan scopes item 6 to those plus fixing the stale comments. (3) The audit's "severity totals summed pre-verifier" is compounded by a double count (the same raw counts recorded on both verify and synth records, `panel.ts:357,419`); T4 fixes both.
- **Opt-in consistency:** no checks config ⇒ `checkSignals(null)` ⇒ `null`s ⇒ `decide` sees exactly today's context; no panel ⇒ `onFindings` never fires ⇒ empty signatures, no `findings.json`, no recurrence; no adaptive router ⇒ the whole observation block is skipped as before. The only behavior changes inside opted-in modes are the panel refusal (Decision 1, locked) and the verdict-reconciled report text on panel runs that record verdicts.
- **Type placement:** `CheckSignals` (T1, progress), `FindingMemoryEntry`/`FindingMemory` (T2), `ReviewVerdicts`/`ConfirmationResult` (T4/T6, review-severity), `ReviewVerdictSummary` (T5, report-finalize); `RunManifest.findingRecurrence` uses a structural type to avoid an import cycle with `finding-memory.ts` (which imports `runReportDir` from `run-report.ts`).
- **House conventions held:** `review-confirm` is a local `Stage` const run via `executeStage`, not in `STAGES` or a chain; new template ships in `templates/`; ESM `.js` imports; no new dependencies; every parser is throws-free; release state untouched.
