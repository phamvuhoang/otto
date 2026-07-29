# P27 Attested Checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Refreshed 2026-07-29** against the approved spec `docs/superpowers/specs/2026-07-29-p27-attested-checks-design.md` and current `main`. The 2026-07-10 revision of this plan predated the spec and cited line anchors from before P32/otto-review landed (91 changed core files). See [Refresh notes](#refresh-notes-2026-07-29) for what changed and why.

**Goal:** Every fix commit in a review path (single `reviewer`, panel `review-synth`, `apply-review-implementer`) and every `--verify` `method:"test"` claim is backed by a check command the **harness itself executed**, recorded as `ChecksRecord` evidence — with the run's verdict driven by the **terminal** attestation, disagreement surfaced in the report and `otto-inspect`, and eval `succeeded` reading attested truth. Absent a `checks` config, runs are byte-for-byte unchanged.

**Architecture:** Two modules. `packages/core/src/checks.ts` holds the pure contract (`ChecksRecord`, `extractFailureSignature`, `summarizeChecks`) plus the impure policy-scoped runner (`runConfiguredChecks`, fail-fast) behind an injectable `CheckCommandRunner` — the `bench.ts` `runFixtureChecks` exit-0 pattern. `packages/core/src/attestation.ts` holds the orchestration: the boundary predicate, the append-only ledger, terminal-state resolution, and exit-reason derivation. The loop wires attestation into the **single existing `recordStage` closure** (`loop.ts:775`), which both the normal stage path and `panel.ts` already call — so panel synth attestation needs no new panel hook.

**Tech Stack:** TypeScript (NodeNext ESM), Node ≥20, vitest. `packages/core` only. No new npm dependencies.

## Global Constraints

- **ESM only.** Relative imports in `packages/core/src/` end in `.js`.
- **No new npm dependencies.** The runner is `spawnSync` + `resolveShell()` (`render.ts:60`), same as `bench.ts`.
- **Off by default.** `readChecksConfig` → `[]` when `.otto/config.json` has no `checks` array; every seam short-circuits on empty config, so a bare run renders, records, reports, and scores exactly as before.
- **Policy-scoped, fail-closed.** Every command passes `checkCommand` (`safety-policy.ts:104`) before spawning; blocked ⇒ recorded failure, never executed. Agent-emitted matrix commands run only on **exact match** against the configured allowlist.
- **Harness-only evidence fields.** `checks`, `checksSummary`, `attestedCheck` are set by the loop/finalize only — never parsed from agent JSON (mirror `artifactExists`, `verification-matrix.ts:49-53`).
- **Terminal state decides the verdict.** `succeeded` reads `terminalFailed`, never the cumulative tally (spec D1).
- **Fail-fast within a boundary.** Checks stop at the first non-zero exit; unrun commands surface as `skipped`, never as records (spec D2).
- **Exit reasons are human-readable sentences,** matching `NEXT_ACTION`'s existing keys (`next-action.ts`) — not kebab-case slugs.
- **CI tests never spawn real check commands** — inject stub runners; the default runner is exercised only by operators.
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test`. Pre-commit runs prettier + typecheck.
- **Never hand-edit release version state.** release-please owns it.

---

### Task 1: Pure checks core (`ChecksRecord`, `extractFailureSignature`, `summarizeChecks`)

**Files:**

- Create: `packages/core/src/checks.ts`
- Modify: `packages/core/src/index.ts` (export the new type + functions)
- Test: `packages/core/src/__tests__/checks.test.ts`

**Interfaces:**

- Consumes: nothing (leaf module this task).
- Produces (the P28-shared contract):
  - `export type ChecksRecord = { command: string; exitCode: number; durationMs: number; outputTail: string; failureSignature: string | null; attestedAt: string };`
  - `export function extractFailureSignature(outputTail: string): string | null;` — pure: first line carrying a failure marker (`FAIL`/`FAILED`/`✗`/`✘`/`Error`/`error TS…`/`ERR!`/`AssertionError`), ANSI-stripped, whitespace-collapsed, durations normalized to `<duration>`, capped at 200 chars; `null` when no line matches.
  - `export function summarizeChecks(records: ChecksRecord[], configuredCount: number): { passed: number; failed: number; skipped: number; failureSignatures: string[] };` — pure: `passed` = exit-0 count, `failed` = the rest, `skipped` = `max(0, configuredCount - records.length)` (fail-fast left them unrun), `failureSignatures` = deduped signatures of failed records (falling back to `` `exit ${exitCode}` ``).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/checks.test.ts
import { describe, it, expect } from "vitest";
import {
  extractFailureSignature,
  summarizeChecks,
  type ChecksRecord,
} from "../checks.js";

const record = (over: Partial<ChecksRecord>): ChecksRecord => ({
  command: "pnpm -r test",
  exitCode: 0,
  durationMs: 100,
  outputTail: "",
  failureSignature: null,
  attestedAt: "2026-07-29T00:00:00.000Z",
  ...over,
});

describe("extractFailureSignature", () => {
  it("extracts the first vitest failure line, ANSI-stripped", () => {
    const tail =
      "  [32m✓[0m src/a.test.ts (3 tests)\n" +
      "  [31mFAIL[0m  src/b.test.ts > summarize > tallies\n" +
      "  another FAIL line\n";
    expect(extractFailureSignature(tail)).toBe(
      "FAIL src/b.test.ts > summarize > tallies"
    );
  });

  it("extracts a tsc error line", () => {
    const tail = "src/x.ts(3,1): error TS2304: Cannot find name 'y'.\n";
    expect(extractFailureSignature(tail)).toBe(
      "src/x.ts(3,1): error TS2304: Cannot find name 'y'."
    );
  });

  it("is stable across differing durations", () => {
    const a = extractFailureSignature("✗ compress survives (312ms)");
    const b = extractFailureSignature("✗ compress survives (7ms)");
    expect(a).toBe(b);
    expect(a).toContain("<duration>");
  });

  it("returns null when no failure marker is present", () => {
    expect(extractFailureSignature("all 42 tests passed\n")).toBeNull();
  });

  it("caps the signature at 200 chars", () => {
    const sig = extractFailureSignature(`FAIL ${"x".repeat(500)}`);
    expect(sig).not.toBeNull();
    expect(sig!.length).toBeLessThanOrEqual(200);
  });
});

describe("summarizeChecks", () => {
  it("tallies passed and failed", () => {
    const s = summarizeChecks(
      [
        record({ exitCode: 0 }),
        record({ exitCode: 1, failureSignature: "FAIL a" }),
      ],
      2
    );
    expect(s).toEqual({
      passed: 1,
      failed: 1,
      skipped: 0,
      failureSignatures: ["FAIL a"],
    });
  });

  it("reports fail-fast skipped commands", () => {
    // 3 configured, ladder stopped after the first failure ⇒ 2 never ran.
    const s = summarizeChecks(
      [record({ exitCode: 1, failureSignature: "FAIL a" })],
      3
    );
    expect(s.skipped).toBe(2);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(1);
  });

  it("dedupes signatures and falls back to the exit code", () => {
    const s = summarizeChecks(
      [
        record({ exitCode: 1, failureSignature: "FAIL a" }),
        record({ exitCode: 1, failureSignature: "FAIL a" }),
        record({ exitCode: 2, failureSignature: null }),
      ],
      3
    );
    expect(s.failureSignatures).toEqual(["FAIL a", "exit 2"]);
  });

  it("never reports negative skipped when records exceed the config", () => {
    expect(summarizeChecks([record({}), record({})], 1).skipped).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks`
Expected: FAIL — `Cannot find module '../checks.js'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// packages/core/src/checks.ts
/**
 * P27 harness-attested checks — the pure core.
 *
 * The harness executes the repo's configured check commands itself instead of
 * trusting an agent's prose that "the suites pass". This module holds the
 * shared P27/P28 contract: the record shape, failure-signature extraction, and
 * the tally. The impure runner lives here too (Task 2); orchestration lives in
 * `attestation.ts`.
 */

/** One harness-executed check command and what the harness observed. */
export type ChecksRecord = {
  command: string;
  /** Process exit code; `-1` for a timeout, spawn failure, or policy block. */
  exitCode: number;
  durationMs: number;
  /** Last {@link OUTPUT_TAIL_LIMIT} chars of combined stdout+stderr. */
  outputTail: string;
  /** Stable, duration-normalized failure fingerprint; `null` when passing. */
  failureSignature: string | null;
  attestedAt: string;
};

const FAILURE_MARKERS =
  /(\bFAILED?\b|✗|✘|\bERR!\b|\bAssertionError\b|\berror TS\d+\b|\bError\b)/;

/** Strip SGR/CSI escapes so signatures don't vary with terminal colour. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

const SIGNATURE_LIMIT = 200;

/**
 * First failure-marked line of `outputTail`, normalized so the same defect
 * yields the same string across runs: ANSI stripped, whitespace collapsed,
 * timings replaced with `<duration>` (otherwise every run is a "new" failure).
 */
export function extractFailureSignature(outputTail: string): string | null {
  for (const raw of stripAnsi(outputTail).split("\n")) {
    if (!FAILURE_MARKERS.test(raw)) continue;
    const line = raw
      .replace(/\(\s*\d+(\.\d+)?\s*(ms|s|m)\s*\)/g, "(<duration>)")
      .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "<duration>")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length === 0) continue;
    return line.slice(0, SIGNATURE_LIMIT);
  }
  return null;
}

/**
 * Tally a boundary's records. `configuredCount` is how many commands were
 * configured, so fail-fast short-circuiting surfaces as `skipped` rather than
 * silently reading as "the rest passed".
 */
export function summarizeChecks(
  records: ChecksRecord[],
  configuredCount: number
): {
  passed: number;
  failed: number;
  skipped: number;
  failureSignatures: string[];
} {
  const passed = records.filter((r) => r.exitCode === 0).length;
  const failedRecords = records.filter((r) => r.exitCode !== 0);
  const signatures: string[] = [];
  for (const r of failedRecords) {
    const sig = r.failureSignature ?? `exit ${r.exitCode}`;
    if (!signatures.includes(sig)) signatures.push(sig);
  }
  return {
    passed,
    failed: failedRecords.length,
    skipped: Math.max(0, configuredCount - records.length),
    failureSignatures: signatures,
  };
}
```

- [ ] **Step 4: Export from the package index**

In `packages/core/src/index.ts`, add alongside the existing exports:

```ts
export {
  extractFailureSignature,
  summarizeChecks,
  type ChecksRecord,
} from "./checks.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/checks.ts packages/core/src/index.ts packages/core/src/__tests__/checks.test.ts
git commit -m "feat(p27): pure checks core - record shape, failure signature, tally"
```

---

### Task 2: `checks` config + policy-scoped fail-fast runner

**Files:**

- Modify: `packages/core/src/checks.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/checks-runner.test.ts`

**Interfaces:**

- Consumes: `ChecksRecord`, `extractFailureSignature` (Task 1); `checkCommand(policy, command): PolicyViolation[]` (`safety-policy.ts:104`); `resolveShell()` (`render.ts:60`).
- Produces:
  - `export type CheckCommandRunner = (command: string, cwd: string, timeoutMs: number) => { status: number | null; output: string };`
  - `export function readChecksConfig(workspaceDir: string): string[];` — tolerant reader mirroring `readSkillsConfig` (`skill-activation.ts:49`); missing/malformed ⇒ `[]`, never throws.
  - `export function runConfiguredChecks(commands: string[], cwd: string, timeoutMs?: number, run?: CheckCommandRunner, policy?: SafetyPolicy, now?: () => string): ChecksRecord[];` — **fail-fast**: runs in order, stops after the first non-zero exit. Injection params are trailing optionals only.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/checks-runner.test.ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  readChecksConfig,
  runConfiguredChecks,
  type CheckCommandRunner,
} from "../checks.js";
import { DEFAULT_POLICY } from "../safety-policy.js";

function workspace(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-checks-"));
  if (config !== undefined) {
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(join(dir, ".otto", "config.json"), JSON.stringify(config));
  }
  return dir;
}

describe("readChecksConfig", () => {
  it("reads a string array", () => {
    const dir = workspace({ checks: ["pnpm -r typecheck", "pnpm -r test"] });
    expect(readChecksConfig(dir)).toEqual([
      "pnpm -r typecheck",
      "pnpm -r test",
    ]);
  });

  it("returns [] when the key is absent (inert)", () => {
    expect(readChecksConfig(workspace({ branchStrategy: "branch" }))).toEqual(
      []
    );
  });

  it("returns [] when there is no config file at all", () => {
    expect(readChecksConfig(workspace())).toEqual([]);
  });

  it("returns [] on malformed JSON rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-checks-"));
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(join(dir, ".otto", "config.json"), "{ not json");
    expect(readChecksConfig(dir)).toEqual([]);
  });

  it("drops non-string entries", () => {
    const dir = workspace({ checks: ["ok", 42, null] });
    expect(readChecksConfig(dir)).toEqual(["ok"]);
  });
});

describe("runConfiguredChecks", () => {
  const clock = () => "2026-07-29T00:00:00.000Z";

  it("records a passing command", () => {
    const run: CheckCommandRunner = () => ({ status: 0, output: "ok\n" });
    const [rec] = runConfiguredChecks(
      ["pnpm -r test"],
      "/w",
      1000,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(rec.exitCode).toBe(0);
    expect(rec.failureSignature).toBeNull();
    expect(rec.attestedAt).toBe("2026-07-29T00:00:00.000Z");
  });

  it("stops at the first failure and never runs later commands", () => {
    const seen: string[] = [];
    const run: CheckCommandRunner = (cmd) => {
      seen.push(cmd);
      return cmd.includes("typecheck")
        ? { status: 2, output: "src/x.ts(3,1): error TS2304: nope\n" }
        : { status: 0, output: "ok\n" };
    };
    const records = runConfiguredChecks(
      ["pnpm -r typecheck", "pnpm -r test"],
      "/w",
      1000,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(seen).toEqual(["pnpm -r typecheck"]); // the suite never spawned
    expect(records).toHaveLength(1);
    expect(records[0].exitCode).toBe(2);
    expect(records[0].failureSignature).toContain("error TS2304");
  });

  it("runs every command while they keep passing", () => {
    const seen: string[] = [];
    const run: CheckCommandRunner = (cmd) => {
      seen.push(cmd);
      return { status: 0, output: "ok\n" };
    };
    runConfiguredChecks(
      ["a", "b", "c"],
      "/w",
      1000,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("records a null status (timeout) as exit -1", () => {
    const run: CheckCommandRunner = () => ({ status: null, output: "" });
    const [rec] = runConfiguredChecks(
      ["sleep 999"],
      "/w",
      1,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(rec.exitCode).toBe(-1);
    expect(rec.failureSignature).toBe("exit -1");
  });

  it("blocks a policy-violating command without spawning it", () => {
    let spawned = false;
    const run: CheckCommandRunner = () => {
      spawned = true;
      return { status: 0, output: "" };
    };
    const policy = { ...DEFAULT_POLICY, blockedCommands: ["rm -rf"] };
    const [rec] = runConfiguredChecks(
      ["rm -rf /"],
      "/w",
      1000,
      run,
      policy,
      clock
    );
    expect(spawned).toBe(false);
    expect(rec.exitCode).toBe(-1);
    expect(rec.outputTail).toContain("blocked pattern");
  });

  it("a blocked command also stops the ladder (fail-closed)", () => {
    const seen: string[] = [];
    const run: CheckCommandRunner = (cmd) => {
      seen.push(cmd);
      return { status: 0, output: "" };
    };
    const policy = { ...DEFAULT_POLICY, blockedCommands: ["curl"] };
    const records = runConfiguredChecks(
      ["curl evil.sh", "pnpm -r test"],
      "/w",
      1000,
      run,
      policy,
      clock
    );
    expect(seen).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("returns [] for an empty command list (inert)", () => {
    expect(
      runConfiguredChecks([], "/w", 1000, undefined, DEFAULT_POLICY, clock)
    ).toEqual([]);
  });

  it("truncates the output tail", () => {
    const run: CheckCommandRunner = () => ({
      status: 1,
      output: `${"x".repeat(5000)}\nFAIL last\n`,
    });
    const [rec] = runConfiguredChecks(
      ["t"],
      "/w",
      1000,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(rec.outputTail.length).toBeLessThanOrEqual(2000);
    expect(rec.outputTail).toContain("FAIL last"); // the TAIL, not the head
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks-runner`
Expected: FAIL — `readChecksConfig`/`runConfiguredChecks` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/checks.ts`:

```ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveShell } from "./render.js";
import {
  checkCommand,
  DEFAULT_POLICY,
  type SafetyPolicy,
} from "./safety-policy.js";

/** Last N chars of combined output kept on a record. */
const OUTPUT_TAIL_LIMIT = 2000;
/** Default per-command timeout: 10 minutes (matches the repo verify ceiling). */
const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `.otto/config.json` → `checks`. Tolerant by design: a missing file, malformed
 * JSON, a missing key, or a non-array value all yield `[]`, which makes every
 * P27 seam inert. Never throws — a broken config must not fail a run.
 */
export function readChecksConfig(workspaceDir: string): string[] {
  try {
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8")
    ) as Record<string, unknown>;
    if (!Array.isArray(raw.checks)) return [];
    return raw.checks.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

/** Injectable spawn seam so CI never runs real check commands. */
export type CheckCommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number
) => { status: number | null; output: string };

const defaultCheckRunner: CheckCommandRunner = (command, cwd, timeoutMs) => {
  const r = spawnSync(command, {
    cwd,
    shell: resolveShell(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: r.status,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
};

/**
 * Execute the configured checks in order, **stopping at the first failure**
 * (spec D2): a red typecheck must not pay for the slow suite. Unrun commands
 * are deliberately absent from the result — `summarizeChecks` reports them as
 * `skipped` so a short-circuited ladder never reads as a passing suite.
 *
 * Fail-closed: a policy-blocked command is recorded as a failure and never
 * spawned, which also stops the ladder.
 */
export function runConfiguredChecks(
  commands: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
  run: CheckCommandRunner = defaultCheckRunner,
  policy: SafetyPolicy = DEFAULT_POLICY,
  now: () => string = () => new Date().toISOString()
): ChecksRecord[] {
  const records: ChecksRecord[] = [];
  for (const command of commands) {
    const violations = checkCommand(policy, command);
    if (violations.length > 0) {
      records.push({
        command,
        exitCode: -1,
        durationMs: 0,
        outputTail: violations.map((v) => v.message).join("; "),
        failureSignature: `policy: ${violations[0].message}`.slice(0, 200),
        attestedAt: now(),
      });
      break; // fail-closed: never keep attesting past a policy violation
    }
    const startedAt = Date.now();
    let status: number | null;
    let output: string;
    try {
      ({ status, output } = run(command, cwd, timeoutMs));
    } catch (e) {
      status = -1;
      output = e instanceof Error ? e.message : String(e);
    }
    const exitCode = status ?? -1;
    const outputTail = output.slice(-OUTPUT_TAIL_LIMIT);
    records.push({
      command,
      exitCode,
      durationMs: Date.now() - startedAt,
      outputTail,
      failureSignature:
        exitCode === 0
          ? null
          : (extractFailureSignature(outputTail) ?? `exit ${exitCode}`),
      attestedAt: now(),
    });
    if (exitCode !== 0) break; // fail-fast
  }
  return records;
}
```

- [ ] **Step 4: Export from the package index**

Extend the Task 1 export block in `packages/core/src/index.ts`:

```ts
export {
  extractFailureSignature,
  summarizeChecks,
  readChecksConfig,
  runConfiguredChecks,
  type ChecksRecord,
  type CheckCommandRunner,
} from "./checks.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks`
Expected: PASS (Task 1's 9 + this task's 14).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/checks.ts packages/core/src/index.ts packages/core/src/__tests__/checks-runner.test.ts
git commit -m "feat(p27): checks config + policy-scoped fail-fast runner"
```

---

### Task 3: `attestation.ts` — ledger, boundary predicate, terminal resolution

**Files:**

- Create: `packages/core/src/attestation.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/attestation.test.ts`

**Interfaces:**

- Consumes: `ChecksRecord`, `runConfiguredChecks`, `summarizeChecks`, `CheckCommandRunner` (Tasks 1–2); `SafetyPolicy`.
- Produces:
  - `export type ChecksSummary = { passed: number; failed: number; skipped: number; failureSignatures: string[]; everFailed: boolean; terminalFailed: number };`
  - `export type AttestationLedger = { entries: { boundary: string; iteration: number; configuredCount: number; records: ChecksRecord[] }[] };` — `configuredCount` is captured at attest time so fail-fast `skipped` is exact rather than inferred.
  - `export type AttestationContext = { commands: string[]; workspaceDir: string; policy: SafetyPolicy; timeoutMs?: number; run?: CheckCommandRunner; now?: () => string };`
  - `export function newLedger(): AttestationLedger;`
  - `export function shouldAttestBoundary(stageName: string): boolean;` — true for `reviewer`, `review-synth`, `apply-review-implementer`.
  - `export function maybeAttest(ledger, stageName, isError, iteration, ctx): ChecksRecord[];` — the single seam the loop calls; returns `[]` (and appends nothing) when not a boundary, when the stage errored, or when `ctx.commands` is empty.
  - `export function resolveAttestation(ledger): { checksSummary: ChecksSummary | null; exitReasonOverride: string | null };`
  - `export const CHECKS_FAILED_REASON = "done with failing checks";`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/attestation.test.ts
import { describe, it, expect } from "vitest";
import {
  newLedger,
  shouldAttestBoundary,
  maybeAttest,
  resolveAttestation,
  CHECKS_FAILED_REASON,
  type AttestationContext,
} from "../attestation.js";
import { DEFAULT_POLICY } from "../safety-policy.js";
import type { CheckCommandRunner } from "../checks.js";

const ctx = (
  commands: string[],
  run: CheckCommandRunner
): AttestationContext => ({
  commands,
  workspaceDir: "/w",
  policy: DEFAULT_POLICY,
  timeoutMs: 1000,
  run,
  now: () => "2026-07-29T00:00:00.000Z",
});

const green: CheckCommandRunner = () => ({ status: 0, output: "ok\n" });
const red: CheckCommandRunner = () => ({ status: 1, output: "FAIL x\n" });

describe("shouldAttestBoundary", () => {
  it("is true for the three HEAD-moving review stages", () => {
    expect(shouldAttestBoundary("reviewer")).toBe(true);
    expect(shouldAttestBoundary("review-synth")).toBe(true);
    expect(shouldAttestBoundary("apply-review-implementer")).toBe(true);
  });

  it("is false for read-only and implement stages", () => {
    for (const s of [
      "implementer",
      "plan",
      "verifier",
      "structural",
      "pr-review-lens",
    ]) {
      expect(shouldAttestBoundary(s)).toBe(false);
    }
  });
});

describe("maybeAttest", () => {
  it("is inert with no configured commands", () => {
    const l = newLedger();
    expect(maybeAttest(l, "reviewer", false, 1, ctx([], green))).toEqual([]);
    expect(l.entries).toHaveLength(0);
  });

  it("is inert for a non-boundary stage", () => {
    const l = newLedger();
    expect(maybeAttest(l, "implementer", false, 1, ctx(["t"], green))).toEqual(
      []
    );
    expect(l.entries).toHaveLength(0);
  });

  it("is inert when the stage errored (nothing was committed)", () => {
    const l = newLedger();
    expect(maybeAttest(l, "reviewer", true, 1, ctx(["t"], green))).toEqual([]);
    expect(l.entries).toHaveLength(0);
  });

  it("appends a ledger entry for a real boundary", () => {
    const l = newLedger();
    const records = maybeAttest(l, "reviewer", false, 2, ctx(["t"], green));
    expect(records).toHaveLength(1);
    expect(l.entries).toEqual([
      { boundary: "reviewer", iteration: 2, configuredCount: 1, records },
    ]);
  });

  it("records a thrown runner as a failure instead of throwing into the loop", () => {
    const l = newLedger();
    const explode = () => {
      throw new Error("spawn EACCES");
    };
    const records = maybeAttest(l, "reviewer", false, 1, ctx(["t"], explode));
    expect(records[0].exitCode).toBe(-1);
    expect(records[0].failureSignature).toContain("attestation error");
    expect(resolveAttestation(l).checksSummary!.terminalFailed).toBe(1);
  });
});

describe("resolveAttestation", () => {
  it("returns null summary when nothing was ever attested (inert run)", () => {
    expect(resolveAttestation(newLedger())).toEqual({
      checksSummary: null,
      exitReasonOverride: null,
    });
  });

  it("recovery: mid-run red then terminal green ⇒ succeeded-shaped result", () => {
    const l = newLedger();
    maybeAttest(l, "reviewer", false, 2, ctx(["t"], red));
    maybeAttest(l, "reviewer", false, 5, ctx(["t"], green));
    const { checksSummary, exitReasonOverride } = resolveAttestation(l);
    expect(checksSummary!.terminalFailed).toBe(0); // verdict: green
    expect(checksSummary!.everFailed).toBe(true); // churn evidence retained
    expect(checksSummary!.failed).toBe(1); // cumulative
    expect(checksSummary!.passed).toBe(1);
    expect(exitReasonOverride).toBeNull();
  });

  it("terminal red drives the override", () => {
    const l = newLedger();
    maybeAttest(l, "reviewer", false, 1, ctx(["t"], green));
    maybeAttest(l, "review-synth", false, 2, ctx(["t"], red));
    const { checksSummary, exitReasonOverride } = resolveAttestation(l);
    expect(checksSummary!.terminalFailed).toBe(1);
    expect(checksSummary!.everFailed).toBe(true);
    expect(exitReasonOverride).toBe(CHECKS_FAILED_REASON);
  });

  it("carries fail-fast skipped counts into the summary", () => {
    const l = newLedger();
    maybeAttest(l, "reviewer", false, 1, ctx(["a", "b", "c"], red));
    expect(resolveAttestation(l).checksSummary!.skipped).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- attestation`
Expected: FAIL — `Cannot find module '../attestation.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/attestation.ts
/**
 * P27 attestation orchestration.
 *
 * Separate from `checks.ts` because the interesting behavior here is
 * **stateful**: which boundary attested last decides the run's verdict, while
 * the cumulative tally is only evidence. Keeping that state in a module rather
 * than in `loop.ts` locals is what makes it unit-testable without spawning a
 * loop.
 */
import {
  runConfiguredChecks,
  summarizeChecks,
  type CheckCommandRunner,
  type ChecksRecord,
} from "./checks.js";
import type { SafetyPolicy } from "./safety-policy.js";

/**
 * Run-level attested-check evidence. `terminalFailed` is the verdict (spec D1);
 * `passed`/`failed`/`failureSignatures`/`everFailed` are cumulative evidence,
 * retained because they are the recurring-failure signal P28 consumes.
 */
export type ChecksSummary = {
  passed: number;
  failed: number;
  skipped: number;
  failureSignatures: string[];
  everFailed: boolean;
  terminalFailed: number;
};

/** Append-only log of what each boundary attested, in fire order. */
export type AttestationLedger = {
  entries: {
    boundary: string;
    iteration: number;
    /** How many commands were configured when this boundary fired, so
     *  fail-fast `skipped` is exact rather than inferred from the widest entry. */
    configuredCount: number;
    records: ChecksRecord[];
  }[];
};

/** Everything a boundary needs to run checks; assembled once by the loop. */
export type AttestationContext = {
  commands: string[];
  workspaceDir: string;
  policy: SafetyPolicy;
  timeoutMs?: number;
  run?: CheckCommandRunner;
  now?: () => string;
};

/**
 * Exit reason for a run whose FINAL attestation was red. Phrased as a sentence
 * to match the existing `NEXT_ACTION` keys ("done with failures", "stopped
 * (budget)"), not as a kebab-case slug.
 */
export const CHECKS_FAILED_REASON = "done with failing checks";

/** The three stages that move HEAD in a review path. */
const BOUNDARIES = new Set([
  "reviewer",
  "review-synth",
  "apply-review-implementer",
]);

export function newLedger(): AttestationLedger {
  return { entries: [] };
}

export function shouldAttestBoundary(stageName: string): boolean {
  return BOUNDARIES.has(stageName);
}

/**
 * The single seam the loop calls from its `recordStage` closure. Inert unless
 * this is a boundary stage that succeeded and checks are configured — an
 * errored stage committed nothing, so there is nothing to attest.
 */
export function maybeAttest(
  ledger: AttestationLedger,
  stageName: string,
  isError: boolean,
  iteration: number,
  ctx: AttestationContext
): ChecksRecord[] {
  if (isError) return [];
  if (ctx.commands.length === 0) return [];
  if (!shouldAttestBoundary(stageName)) return [];
  let records: ChecksRecord[];
  try {
    records = runConfiguredChecks(
      ctx.commands,
      ctx.workspaceDir,
      ctx.timeoutMs,
      ctx.run,
      ctx.policy,
      ctx.now
    );
  } catch (e) {
    // Fail-closed, and NEVER throw into the loop: an attestation that could not
    // run is recorded as a failure, never as a silent green.
    const message = e instanceof Error ? e.message : String(e);
    records = [
      {
        command: ctx.commands[0],
        exitCode: -1,
        durationMs: 0,
        outputTail: `attestation error: ${message}`,
        failureSignature: `attestation error: ${message}`.slice(0, 200),
        attestedAt: (ctx.now ?? (() => new Date().toISOString()))(),
      },
    ];
  }
  ledger.entries.push({
    boundary: stageName,
    iteration,
    configuredCount: ctx.commands.length,
    records,
  });
  return records;
}

/**
 * Fold the ledger into the run-level summary and decide whether the exit reason
 * must be overridden. The LAST entry is the terminal state: a failure a later
 * iteration fixed must not sink the run (spec D1).
 */
export function resolveAttestation(ledger: AttestationLedger): {
  checksSummary: ChecksSummary | null;
  exitReasonOverride: string | null;
} {
  if (ledger.entries.length === 0) {
    return { checksSummary: null, exitReasonOverride: null };
  }
  const all = ledger.entries.flatMap((e) => e.records);
  const configuredTotal = ledger.entries.reduce(
    (n, e) => n + e.configuredCount,
    0
  );
  const cumulative = summarizeChecks(all, configuredTotal);

  const last = ledger.entries[ledger.entries.length - 1];
  const terminal = summarizeChecks(last.records, last.configuredCount);

  return {
    checksSummary: {
      passed: cumulative.passed,
      failed: cumulative.failed,
      skipped,
      failureSignatures: cumulative.failureSignatures,
      everFailed: cumulative.failed > 0,
      terminalFailed: terminal.failed,
    },
    exitReasonOverride: terminal.failed > 0 ? CHECKS_FAILED_REASON : null,
  };
}
```

- [ ] **Step 4: Export from the package index**

```ts
export {
  newLedger,
  shouldAttestBoundary,
  maybeAttest,
  resolveAttestation,
  CHECKS_FAILED_REASON,
  type AttestationLedger,
  type AttestationContext,
  type ChecksSummary,
} from "./attestation.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- attestation`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/attestation.ts packages/core/src/index.ts packages/core/src/__tests__/attestation.test.ts
git commit -m "feat(p27): attestation ledger, boundary predicate, terminal resolution"
```

---

### Task 4: Evidence shapes — `StageRecord.checks`, `RunManifest.checksSummary`, `otto-inspect`

**Files:**

- Modify: `packages/core/src/run-report.ts` (`StageRecord` at `:148`, `RunManifest` at `:225` — mirror the `inputSharpness` optional-field pattern at `:253`)
- Modify: `packages/core/src/inspect.ts` (manifest line after the sharpness block at `:143-148`; per-stage lines after the skills block at `:163-167`)
- Test: `packages/core/src/__tests__/checks-evidence.test.ts`

**Interfaces:**

- Consumes: `ChecksRecord` (Task 1), `ChecksSummary` (Task 3); `writeStageRecord`/`readStageRecords`/`writeManifest`/`readManifest` (`run-report.ts`).
- Produces:
  - `StageRecord.checks?: ChecksRecord[];` — absent = no checks configured or no boundary fired for this stage.
  - `RunManifest.checksSummary?: ChecksSummary;` — absent for every run that never attested.
  - `formatRunReport` renders `  checks:      N passed, M failed, K skipped (harness-attested)` on the manifest header and `      check: PASS|FAIL <cmd> (exit N, Tms)` under each stage carrying records.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/checks-evidence.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { formatRunReport } from "../inspect.js";
import {
  readManifest,
  readStageRecords,
  writeManifest,
  writeStageRecord,
  type RunManifest,
  type StageRecord,
} from "../run-report.js";
import type { ChecksRecord } from "../checks.js";
import { emptyTokenUsage } from "../tokens.js";

const CHECK: ChecksRecord = {
  command: "pnpm -r test",
  exitCode: 1,
  durationMs: 8123,
  outputTail: "FAIL src/b.test.ts > adds\n",
  failureSignature: "FAIL src/b.test.ts > adds",
  attestedAt: "2026-07-29T00:01:00.000Z",
};

const stage = (over: Partial<StageRecord>): StageRecord => ({
  iteration: 1,
  stage: "reviewer",
  runtimeId: "claude",
  costUsd: 0.1,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-07-29T00:00:00.000Z",
  finishedAt: "2026-07-29T00:01:00.000Z",
  ...over,
});

const manifest = (over: Partial<RunManifest>): RunManifest =>
  ({
    runId: "r1",
    bin: "otto-ghafk",
    mode: "ghafk",
    inputs: "",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 1,
    costUsd: 0.1,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: "2026-07-29T00:02:00.000Z",
    ...over,
  }) as RunManifest;

describe("checks evidence round-trip", () => {
  it("persists StageRecord.checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-ev-"));
    writeStageRecord(dir, "r1", 0, stage({ checks: [CHECK] }));
    expect(readStageRecords(dir, "r1")[0].checks).toEqual([CHECK]);
  });

  it("persists RunManifest.checksSummary", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-ev-"));
    const summary = {
      passed: 1,
      failed: 1,
      skipped: 1,
      failureSignatures: ["FAIL src/b.test.ts > adds"],
      everFailed: true,
      terminalFailed: 1,
    };
    writeManifest(dir, "r1", manifest({ checksSummary: summary }));
    expect(readManifest(dir, "r1")!.checksSummary).toEqual(summary);
  });

  it("omits both fields on an inert run", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-ev-"));
    writeStageRecord(dir, "r1", 0, stage({}));
    writeManifest(dir, "r1", manifest({}));
    expect(readStageRecords(dir, "r1")[0].checks).toBeUndefined();
    expect(readManifest(dir, "r1")!.checksSummary).toBeUndefined();
  });
});

describe("formatRunReport renders attested checks", () => {
  it("renders the manifest tally and the per-stage lines", () => {
    const out = formatRunReport(
      manifest({
        checksSummary: {
          passed: 1,
          failed: 1,
          skipped: 1,
          failureSignatures: ["FAIL src/b.test.ts > adds"],
          everFailed: true,
          terminalFailed: 1,
        },
      }),
      [stage({ checks: [CHECK] })]
    );
    expect(out).toContain("1 passed, 1 failed, 1 skipped (harness-attested)");
    expect(out).toContain("check: FAIL `pnpm -r test` (exit 1, 8123ms)");
  });

  it("renders nothing extra for an inert run", () => {
    const out = formatRunReport(manifest({}), [stage({})]);
    expect(out).not.toContain("harness-attested");
    expect(out).not.toContain("check:");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks-evidence`
Expected: FAIL — `checks` / `checksSummary` are not properties of the types (typecheck), and the render assertions miss.

- [ ] **Step 3: Add the fields**

In `packages/core/src/run-report.ts`, inside `StageRecord` (`:148`), beside the other optional evidence fields:

```ts
  /** Harness-attested check results for a boundary stage (P27, issue #246);
   *  absent = no checks configured or this stage is not an attestation
   *  boundary. Set by the loop only — never parsed from agent JSON. */
  checks?: ChecksRecord[];
```

Inside `RunManifest` (`:225`), beside `inputSharpness` (`:253`):

```ts
  /** Run-level attested-check evidence (P27, issue #246); absent when the run
   *  never attested. `terminalFailed` is the verdict; the cumulative fields are
   *  churn evidence for P28. */
  checksSummary?: ChecksSummary;
```

Add the imports at the top of `run-report.ts`:

```ts
import type { ChecksRecord } from "./checks.js";
import type { ChecksSummary } from "./attestation.js";
```

- [ ] **Step 4: Render them in `otto-inspect`**

In `packages/core/src/inspect.ts`, immediately after the `inputSharpness` block (`:143-148`):

```ts
if (manifest.checksSummary) {
  const c = manifest.checksSummary;
  lines.push(
    `  checks:      ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped (harness-attested)`
  );
  if (c.terminalFailed > 0) {
    lines.push(
      `               FINAL STATE RED — ${c.failureSignatures[0] ?? "see stage records"}`
    );
  } else if (c.everFailed) {
    lines.push(`               (recovered — earlier iterations were red)`);
  }
}
```

And inside the `stages.forEach` callback, immediately after the `skillsUsed` block (`:163-167`):

```ts
if (s.checks && s.checks.length > 0) {
  for (const c of s.checks) {
    lines.push(
      `      check: ${c.exitCode === 0 ? "PASS" : "FAIL"} \`${c.command}\` (exit ${c.exitCode}, ${c.durationMs}ms)`
    );
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks-evidence`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/run-report.ts packages/core/src/inspect.ts packages/core/src/__tests__/checks-evidence.test.ts
git commit -m "feat(p27): stage/manifest checks evidence + otto-inspect rendering"
```

---

### Task 5: Attest at the review boundary (loop wiring)

**Files:**

- Modify: `packages/core/src/loop.ts` (`recordStage` closure at `:775-820`; ledger + context construction near the run-id/manifest setup)
- Test: `packages/core/src/__tests__/attestation-wiring.test.ts`

**Interfaces:**

- Consumes: `newLedger`, `maybeAttest`, `AttestationContext` (Task 3); `readChecksConfig` (Task 2); `StageRecord.checks` (Task 4).
- Produces: no new exports. `recordStage` attaches `checks` to the record it writes, for `reviewer` (direct chain) and `review-synth` (via `panel.ts`, which already calls this same closure — **no panel change needed**).

**Why this seam:** `panel.ts`'s `recordStage?: (stageName, sr, startedAt, reviewSeverity?) => void` hook (`panel.ts:175-189`) is the loop's own closure. Hooking attestation there covers the single reviewer and the panel synth with one wiring point.

- [ ] **Step 1: Write the failing test**

This test exercises the wiring contract without booting a loop: a `recordStage`-shaped function built from the same pieces.

```ts
// packages/core/src/__tests__/attestation-wiring.test.ts
import { describe, it, expect } from "vitest";
import {
  newLedger,
  maybeAttest,
  resolveAttestation,
  type AttestationContext,
} from "../attestation.js";
import { DEFAULT_POLICY } from "../safety-policy.js";
import type { CheckCommandRunner } from "../checks.js";
import type { ChecksRecord } from "../checks.js";

/** Mirror of the loop's recordStage attestation seam. */
function recordStageLike(
  ledger: ReturnType<typeof newLedger>,
  ctx: AttestationContext,
  stageName: string,
  isError: boolean,
  iteration: number
): { stage: string; checks?: ChecksRecord[] } {
  const checks = maybeAttest(ledger, stageName, isError, iteration, ctx);
  return { stage: stageName, ...(checks.length > 0 ? { checks } : {}) };
}

const ctx = (
  commands: string[],
  run: CheckCommandRunner
): AttestationContext => ({
  commands,
  workspaceDir: "/w",
  policy: DEFAULT_POLICY,
  timeoutMs: 1000,
  run,
  now: () => "2026-07-29T00:00:00.000Z",
});

const green: CheckCommandRunner = () => ({ status: 0, output: "ok\n" });
const red: CheckCommandRunner = () => ({ status: 1, output: "FAIL x\n" });

describe("recordStage attestation seam", () => {
  it("attaches checks to a reviewer record", () => {
    const l = newLedger();
    const rec = recordStageLike(l, ctx(["t"], green), "reviewer", false, 1);
    expect(rec.checks).toHaveLength(1);
    expect(rec.checks![0].exitCode).toBe(0);
  });

  it("attaches checks to a panel synth record (same closure)", () => {
    const l = newLedger();
    const rec = recordStageLike(l, ctx(["t"], red), "review-synth", false, 1);
    expect(rec.checks![0].exitCode).toBe(1);
  });

  it("leaves implementer and lens records untouched", () => {
    const l = newLedger();
    expect(
      recordStageLike(l, ctx(["t"], green), "implementer", false, 1).checks
    ).toBeUndefined();
    expect(
      recordStageLike(l, ctx(["t"], green), "structural", false, 1).checks
    ).toBeUndefined();
    expect(l.entries).toHaveLength(0);
  });

  it("is inert end-to-end with no checks configured", () => {
    const l = newLedger();
    const rec = recordStageLike(l, ctx([], green), "reviewer", false, 1);
    expect(rec.checks).toBeUndefined();
    expect(resolveAttestation(l).checksSummary).toBeNull();
  });

  it("a multi-iteration run resolves on the terminal boundary", () => {
    const l = newLedger();
    recordStageLike(l, ctx(["t"], red), "reviewer", false, 2);
    recordStageLike(l, ctx(["t"], green), "reviewer", false, 5);
    const { checksSummary } = resolveAttestation(l);
    expect(checksSummary!.terminalFailed).toBe(0);
    expect(checksSummary!.everFailed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- attestation-wiring`
Expected: PASS if Task 3 is complete — this test pins the wiring contract. If it fails, Task 3's `maybeAttest` filtering is wrong; fix that before wiring the loop.

- [ ] **Step 3: Wire the loop**

In `packages/core/src/loop.ts`, near where `runId` and the recorded-stage bookkeeping are set up (just above `const recordedStageFiles: string[] = []`, `:771`):

```ts
// P27: harness-attested checks. Inert unless `.otto/config.json` has `checks`.
const checkCommands = readChecksConfig(workspaceDir);
const attestationLedger = newLedger();
const attestationCtx: AttestationContext = {
  commands: checkCommands,
  workspaceDir,
  policy,
};
```

Inside the `recordStage` closure (`:775`), after `stageLog.push(...)` and before the `writeStageRecord` call:

```ts
const attestedChecks = maybeAttest(
  attestationLedger,
  stageName,
  sr.isError,
  recIteration,
  attestationCtx
);
```

Then add to the record object literal (`:800-815`), beside the other conditional spreads:

```ts
          ...(attestedChecks.length > 0 ? { checks: attestedChecks } : {}),
```

Add the imports at the top of `loop.ts`:

```ts
import { readChecksConfig } from "./checks.js";
import {
  newLedger,
  maybeAttest,
  resolveAttestation,
  CHECKS_FAILED_REASON,
  type AttestationContext,
} from "./attestation.js";
```

> `policy` is the already-resolved `SafetyPolicy` in loop scope. If it is named
> differently at the wiring point, pass that binding — do not re-read the policy.

- [ ] **Step 4: Verify nothing regressed**

Run: `pnpm -r typecheck && pnpm --filter @phamvuhoang/otto-core test`
Expected: PASS. Existing loop tests construct no `checks` config, so `maybeAttest` short-circuits and every record is byte-identical.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop.ts packages/core/src/__tests__/attestation-wiring.test.ts
git commit -m "feat(p27): attest at the reviewer/synth boundary via recordStage"
```

---

### Task 6: Terminal-red exit reason + `nextAction`

**Files:**

- Modify: `packages/core/src/next-action.ts` (the `NEXT_ACTION` map)
- Modify: `packages/core/src/loop.ts` (the two manifest finalize sites at `:1085` and `:1180`)
- Test: `packages/core/src/__tests__/checks-exit-reason.test.ts`

**Interfaces:**

- Consumes: `resolveAttestation`, `CHECKS_FAILED_REASON` (Task 3); `nextActionFor` (`next-action.ts:24`).
- Produces: `NEXT_ACTION["done with failing checks"]`. The loop derives the final reason as: override only when the loop's own reason is a success reason.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/checks-exit-reason.test.ts
import { describe, it, expect } from "vitest";
import { nextActionFor } from "../next-action.js";
import { CHECKS_FAILED_REASON } from "../attestation.js";

/** Mirror of the loop's reason-override rule (spec D3). */
export function finalReason(
  loopReason: string,
  exitReasonOverride: string | null
): string {
  const SUCCESS = new Set(["complete", "done"]);
  return exitReasonOverride && SUCCESS.has(loopReason)
    ? exitReasonOverride
    : loopReason;
}

describe("terminal-red exit reason", () => {
  it("overrides a success reason", () => {
    expect(finalReason("complete", CHECKS_FAILED_REASON)).toBe(
      CHECKS_FAILED_REASON
    );
    expect(finalReason("done", CHECKS_FAILED_REASON)).toBe(
      CHECKS_FAILED_REASON
    );
  });

  it("never masks a more informative failure reason", () => {
    expect(finalReason("stopped (budget)", CHECKS_FAILED_REASON)).toBe(
      "stopped (budget)"
    );
    expect(finalReason("halted (rate limit)", CHECKS_FAILED_REASON)).toBe(
      "halted (rate limit)"
    );
  });

  it("leaves the reason alone when checks were green or inert", () => {
    expect(finalReason("complete", null)).toBe("complete");
  });

  it("has a maintainer-facing next action", () => {
    expect(nextActionFor(CHECKS_FAILED_REASON)).toContain("otto-inspect");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks-exit-reason`
Expected: FAIL — `nextActionFor` returns the generic "re-run to resume" fallback.

- [ ] **Step 3: Add the next-action entry**

In `packages/core/src/next-action.ts`, add to `NEXT_ACTION`:

```ts
  "done with failing checks":
    "harness-attested checks failed at the final review commit — run `otto-inspect <run-id>` for the failing command and output tail",
```

- [ ] **Step 4: Apply the override in the loop**

At both manifest finalize sites in `loop.ts` (`:1085` and `:1180`), replace the `exitReason` / `nextAction` pair. Compute once, just before each manifest literal:

```ts
const { checksSummary, exitReasonOverride } =
  resolveAttestation(attestationLedger);
const SUCCESS_EXIT = new Set(["complete", "done"]);
const finalReason =
  exitReasonOverride && SUCCESS_EXIT.has(reason) ? exitReasonOverride : reason;
```

Then in the manifest literal:

```ts
        exitReason: finalReason,
        nextAction: nextActionFor(finalReason),
        ...(checksSummary ? { checksSummary } : {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -r typecheck && pnpm --filter @phamvuhoang/otto-core test`
Expected: PASS. Runs without a `checks` config get `exitReasonOverride === null` and `checksSummary === null`, so both fields are unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/next-action.ts packages/core/src/loop.ts packages/core/src/__tests__/checks-exit-reason.test.ts
git commit -m "feat(p27): terminal-red exit reason + maintainer next action"
```

---

### Task 7: Disagreement surfacing in the finalized run report

**Files:**

- Modify: `packages/core/src/report-finalize.ts` (`FinalizeReportContext` at `:30-36`; the fallback report builder `buildFallbackRunReport` at `:312`; `finalizeReportText` at `:380`)
- Test: `packages/core/src/__tests__/checks-disagreement.test.ts`

**Interfaces:**

- Consumes: `ChecksSummary` (Task 3).
- Produces:
  - `FinalizeReportContext.checksSummary?: ChecksSummary;`
  - `export function formatAttestedChecks(summary: ChecksSummary | undefined): string;` — returns `""` when absent (inert), else an "Attested Checks" markdown block. When `terminalFailed > 0` the block opens with the disagreement callout, because a fix commit **is** the agent's claim of green (spec D4) — no prose parsing.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/checks-disagreement.test.ts
import { describe, it, expect } from "vitest";
import { formatAttestedChecks } from "../report-finalize.js";
import type { ChecksSummary } from "../attestation.js";

const summary = (over: Partial<ChecksSummary>): ChecksSummary => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  failureSignatures: [],
  everFailed: false,
  terminalFailed: 0,
  ...over,
});

describe("formatAttestedChecks", () => {
  it("is empty for an inert run", () => {
    expect(formatAttestedChecks(undefined)).toBe("");
  });

  it("reports a clean attestation", () => {
    const out = formatAttestedChecks(summary({ passed: 2 }));
    expect(out).toContain("Attested Checks");
    expect(out).toContain("2 passed");
    expect(out).not.toContain("DISAGREEMENT");
  });

  it("flags disagreement when the final state is red", () => {
    const out = formatAttestedChecks(
      summary({
        passed: 1,
        failed: 1,
        terminalFailed: 1,
        everFailed: true,
        failureSignatures: ["FAIL src/b.test.ts > adds"],
      })
    );
    expect(out).toContain("DISAGREEMENT");
    expect(out).toContain("the agent committed a fix");
    expect(out).toContain("FAIL src/b.test.ts > adds");
  });

  it("notes recovery when earlier iterations were red but the final state is green", () => {
    const out = formatAttestedChecks(
      summary({ passed: 2, failed: 1, everFailed: true, terminalFailed: 0 })
    );
    expect(out).not.toContain("DISAGREEMENT");
    expect(out).toContain("recovered");
  });

  it("discloses fail-fast skipped commands", () => {
    const out = formatAttestedChecks(
      summary({ failed: 1, skipped: 2, terminalFailed: 1 })
    );
    expect(out).toContain("2 not run (fail-fast)");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks-disagreement`
Expected: FAIL — `formatAttestedChecks` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `packages/core/src/report-finalize.ts`:

```ts
import type { ChecksSummary } from "./attestation.js";

/**
 * The "Attested Checks" report block (P27). Disagreement is structural, not
 * parsed (spec D4): a fix commit IS the agent's claim that the suites pass, so
 * a red terminal attestation at a committed boundary is by definition a
 * contradiction — no NLP over report prose.
 */
export function formatAttestedChecks(
  summary: ChecksSummary | undefined
): string {
  if (!summary) return "";
  const lines: string[] = ["", "## Attested Checks", ""];
  if (summary.terminalFailed > 0) {
    lines.push(
      "**DISAGREEMENT — the agent committed a fix, but the harness observed a failing check.**",
      ""
    );
  }
  const tally =
    `- ${summary.passed} passed, ${summary.failed} failed` +
    (summary.skipped > 0 ? `, ${summary.skipped} not run (fail-fast)` : "");
  lines.push(tally);
  if (summary.terminalFailed === 0 && summary.everFailed) {
    lines.push(
      "- Final state green (recovered — earlier iterations were red)."
    );
  }
  for (const sig of summary.failureSignatures) {
    lines.push(`- \`${sig}\``);
  }
  return `${lines.join("\n")}\n`;
}
```

Add the optional field to `FinalizeReportContext` (`:30-36`):

```ts
  /** Attested-check evidence for the P27 report block; absent = inert run. */
  checksSummary?: ChecksSummary;
```

Then append the block in both `buildFallbackRunReport` (`:312`) and `finalizeReportText` (`:380`). Each currently ends by returning an assembled string; wrap that return value:

```ts
// was: return text;
return `${text}${formatAttestedChecks(ctx.checksSummary)}`;
```

`formatAttestedChecks` returns `""` for an inert run, so this is a no-op without a `checks` config — which is what keeps the byte-for-byte guarantee.

Finally, at the loop's two finalize call sites (`loop.ts:1085` and `:1180`), pass the summary resolved in Task 6 into the finalize context:

```ts
        ...(checksSummary ? { checksSummary } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- checks-disagreement`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/report-finalize.ts packages/core/src/loop.ts packages/core/src/__tests__/checks-disagreement.test.ts
git commit -m "feat(p27): attested-checks report block with structural disagreement callout"
```

---

### Task 8: Eval truth signal — `succeeded` reads terminal attestation

**Files:**

- Modify: `packages/core/src/eval.ts` (`EvalSignals` at `:18-32`, `scoreTrajectory` at `:99-105`)
- Test: `packages/core/src/__tests__/eval-attested.test.ts`

**Interfaces:**

- Consumes: `RunManifest.checksSummary` (Task 4).
- Produces:
  - `EvalSignals.attestedTerminalFailures: number;` — `0` when the run never attested.
  - `succeeded` becomes: exit reason in `SUCCESS_REASONS` **AND** (`checksSummary` absent **OR** `terminalFailed === 0`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/eval-attested.test.ts
import { describe, it, expect } from "vitest";
import { scoreTrajectory } from "../eval.js";
import type { RunManifest } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";
import type { ChecksSummary } from "../attestation.js";

const manifest = (over: Partial<RunManifest>): RunManifest =>
  ({
    runId: "r1",
    bin: "otto-ghafk",
    mode: "ghafk",
    inputs: "",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 1,
    costUsd: 0,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
    exitReason: "complete",
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: "2026-07-29T00:02:00.000Z",
    ...over,
  }) as RunManifest;

const summary = (over: Partial<ChecksSummary>): ChecksSummary => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  failureSignatures: [],
  everFailed: false,
  terminalFailed: 0,
  ...over,
});

describe("eval succeeded incorporates attested checks", () => {
  it("disagreement fixture: exit-reason success + terminal red ⇒ succeeded false", () => {
    const s = scoreTrajectory(
      manifest({
        checksSummary: summary({
          failed: 1,
          terminalFailed: 1,
          everFailed: true,
        }),
      }),
      []
    );
    expect(s.exitReason).toBe("complete"); // exit reason alone still says success…
    expect(s.succeeded).toBe(false); // …but the attested truth wins.
    expect(s.attestedTerminalFailures).toBe(1);
  });

  it("recovery fixture: mid-run red, terminal green ⇒ succeeded true", () => {
    const s = scoreTrajectory(
      manifest({
        checksSummary: summary({
          passed: 2,
          failed: 1,
          everFailed: true,
          terminalFailed: 0,
        }),
      }),
      []
    );
    expect(s.succeeded).toBe(true); // the loop fixed it — that is a WIN
    expect(s.attestedTerminalFailures).toBe(0);
  });

  it("attested pass keeps succeeded true", () => {
    const s = scoreTrajectory(
      manifest({ checksSummary: summary({ passed: 2 }) }),
      []
    );
    expect(s.succeeded).toBe(true);
  });

  it("inert fixture: no checksSummary ⇒ unchanged behavior", () => {
    const s = scoreTrajectory(manifest({}), []);
    expect(s.succeeded).toBe(true);
    expect(s.attestedTerminalFailures).toBe(0);
  });

  it("a failing exit reason stays failing regardless of green checks", () => {
    const s = scoreTrajectory(
      manifest({
        exitReason: "stopped (budget)",
        checksSummary: summary({ passed: 2 }),
      }),
      []
    );
    expect(s.succeeded).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- eval-attested`
Expected: FAIL — `attestedTerminalFailures` missing from `EvalSignals` (typecheck) and `succeeded` still true on the disagreement fixture.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/eval.ts`, add to `EvalSignals`:

```ts
/** Failing checks in the run's FINAL attestation (P27); 0 when never attested.
 *  Terminal, not cumulative: a failure a later iteration fixed is not a loss. */
attestedTerminalFailures: number;
```

And in `scoreTrajectory`, replace the `succeeded` line (`:101`):

```ts
  const exitReason = manifest.exitReason ?? null;
  const attestedTerminalFailures = manifest.checksSummary?.terminalFailed ?? 0;
  return {
    succeeded:
      exitReason != null &&
      SUCCESS_REASONS.has(exitReason) &&
      attestedTerminalFailures === 0,
    attestedTerminalFailures,
    exitReason,
    // …remaining fields unchanged
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- eval`
Expected: PASS. Existing eval tests build manifests without `checksSummary`, so `attestedTerminalFailures` is 0 and `succeeded` is unchanged for them.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/eval.ts packages/core/src/__tests__/eval-attested.test.ts
git commit -m "feat(p27): eval succeeded reads terminal attestation + recovery fixture"
```

---

### Task 9: `--verify` re-execution of `method:"test"` rows + docs

**Files:**

- Modify: `packages/core/src/verification-matrix.ts` (`VerificationEntry` at `:36-64`; `coerceEntry` at `:153-179`)
- Modify: `packages/core/src/loop.ts` (the verify-mode matrix validation site, beside where `artifactExists` is set)
- Modify: `README.md`, `docs/CONFIG.md`, `docs/ARCHITECTURE.md`, `docs/HARNESS_ROADMAP_PHASE6.md`
- Test: `packages/core/src/__tests__/verify-attested.test.ts`

**Interfaces:**

- Consumes: `runConfiguredChecks`, `readChecksConfig` (Task 2).
- Produces:
  - `VerificationEntry.attestedCheck?: { command: string; exitCode: number; durationMs: number };` — harness-only, never read from agent JSON (`coerceEntry` must strip it, exactly like `artifactExists`).
  - `export function attestMatrixRows(entries, commands, cwd, run?, policy?): VerificationEntry[];` — re-executes only rows whose `method === "test"` and whose **`check`** field (documented as "the concrete check: the command run", `verification-matrix.ts:40`) **exactly matches** a configured check. Non-matching rows are left untouched (a coverage gap, not a failure).

> **Field note:** the command lives in `VerificationEntry.check`, **not** in
> `artifactPath` — `artifactPath` is a `file:line`/SHA/screenshot pointer. Matching
> against `artifactPath` would never fire.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/verify-attested.test.ts
import { describe, it, expect } from "vitest";
import {
  attestMatrixRows,
  parseVerificationMatrix,
  type VerificationEntry,
} from "../verification-matrix.js";
import { DEFAULT_POLICY } from "../safety-policy.js";
import type { CheckCommandRunner } from "../checks.js";

const green: CheckCommandRunner = () => ({ status: 0, output: "ok\n" });
const red: CheckCommandRunner = () => ({ status: 1, output: "FAIL x\n" });

/** `check` carries the command; `artifactPath` is a pointer, never a command. */
const row = (over: Partial<VerificationEntry> = {}): VerificationEntry => ({
  requirement: "adds two numbers",
  method: "test",
  result: "pass",
  check: "pnpm -r test",
  ...over,
});

describe("attestMatrixRows", () => {
  it("re-executes an exactly-matching test row", () => {
    const [e] = attestMatrixRows(
      [row()],
      ["pnpm -r test"],
      "/w",
      green,
      DEFAULT_POLICY
    );
    expect(e.attestedCheck).toEqual({
      command: "pnpm -r test",
      exitCode: 0,
      durationMs: expect.any(Number),
    });
  });

  it("records a failing re-execution", () => {
    const [e] = attestMatrixRows(
      [row()],
      ["pnpm -r test"],
      "/w",
      red,
      DEFAULT_POLICY
    );
    expect(e.attestedCheck!.exitCode).toBe(1);
  });

  it("never runs a command that is not an exact configured match", () => {
    let spawned = false;
    const spy: CheckCommandRunner = () => {
      spawned = true;
      return { status: 0, output: "" };
    };
    const [e] = attestMatrixRows(
      [row({ check: "pnpm -r test --reporter=evil" })],
      ["pnpm -r test"],
      "/w",
      spy,
      DEFAULT_POLICY
    );
    expect(spawned).toBe(false);
    expect(e.attestedCheck).toBeUndefined(); // a gap, not a failure
  });

  it("ignores non-test methods", () => {
    let spawned = false;
    const spy: CheckCommandRunner = () => {
      spawned = true;
      return { status: 0, output: "" };
    };
    attestMatrixRows(
      [row({ method: "visual" })],
      ["pnpm -r test"],
      "/w",
      spy,
      DEFAULT_POLICY
    );
    expect(spawned).toBe(false);
  });

  it("is inert with no configured checks", () => {
    const [e] = attestMatrixRows([row()], [], "/w", green, DEFAULT_POLICY);
    expect(e.attestedCheck).toBeUndefined();
  });
});

describe("the parser strips harness-only fields", () => {
  it("never trusts an agent-supplied attestedCheck", () => {
    const raw = JSON.stringify([
      {
        requirement: "adds two numbers",
        method: "test",
        result: "pass",
        check: "pnpm -r test",
        attestedCheck: { command: "echo pwned", exitCode: 0, durationMs: 1 },
      },
    ]);
    const entries = parseVerificationMatrix(raw);
    expect(entries[0].attestedCheck).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- verify-attested`
Expected: FAIL — `attestMatrixRows` is not exported.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/verification-matrix.ts`, add to `VerificationEntry` (`:36-64`):

```ts
  /** Set by the loop when a `method:"test"` row's cited command exactly matched
   *  a configured check and the harness re-executed it (P27). Absent ⇒ the row
   *  was not re-executed (a coverage gap, never a failure). Never read from
   *  agent JSON — `coerceEntry` strips it. */
  attestedCheck?: { command: string; exitCode: number; durationMs: number };
```

In `coerceEntry` (`:153-179`), ensure the returned object never copies `attestedCheck` from input — it builds a fresh object from validated fields, so simply do **not** add it there. The test above pins this.

Then add the re-execution helper:

```ts
import { runConfiguredChecks, type CheckCommandRunner } from "./checks.js";
import { DEFAULT_POLICY, type SafetyPolicy } from "./safety-policy.js";

/**
 * Re-execute `method:"test"` rows in `--verify` mode so a "pass" is something
 * the harness watched rather than something the agent asserted.
 *
 * Exact-match-only against the configured allowlist: matrix rows are
 * agent-emitted strings, and a fuzzy match would hand an untrusted string to a
 * shell. A non-matching row is a coverage gap, not a failure.
 */
export function attestMatrixRows(
  entries: VerificationEntry[],
  commands: string[],
  cwd: string,
  run?: CheckCommandRunner,
  policy: SafetyPolicy = DEFAULT_POLICY
): VerificationEntry[] {
  if (commands.length === 0) return entries;
  return entries.map((e) => {
    if (e.method !== "test") return e;
    const cited = e.check.trim(); // `check` is the command; artifactPath is a pointer
    if (!commands.includes(cited)) return e;
    const [rec] = runConfiguredChecks([cited], cwd, undefined, run, policy);
    if (!rec) return e;
    return {
      ...e,
      attestedCheck: {
        command: rec.command,
        exitCode: rec.exitCode,
        durationMs: rec.durationMs,
      },
    };
  });
}
```

Wire it in `loop.ts` in verify mode, immediately after the existing `artifactExists` validation pass:

```ts
verification = attestMatrixRows(verification, checkCommands, workspaceDir);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- verify-attested`
Expected: PASS (6 tests).

- [ ] **Step 5: Update the docs**

- `docs/CONFIG.md` — document the `checks` key: a string array of shell commands, run in order, fail-fast; absent ⇒ inert.
- `README.md` — an "Attested checks" subsection with the three sentences that matter: (1) the harness runs these itself after every review-path fix commit and records exit code/duration/output tail — agent claims are attested, not trusted; (2) a **terminal** failing check overrides the exit reason and eval `succeeded`, while a failure a later iteration fixed does not; (3) no `checks` key ⇒ zero behavior change.
- `docs/ARCHITECTURE.md` — the attestation boundaries, the two-module split, and where the evidence lands: stage records → manifest `checksSummary` → report "Attested Checks" → `otto-inspect` → eval `succeeded`.
- `docs/HARNESS_ROADMAP_PHASE6.md` — mark P27 shipped in the status note and the priority table.

- [ ] **Step 6: Full verify and commit**

```bash
pnpm -r typecheck && pnpm -r test && pnpm test
git add -A
git commit -m "feat(p27): verify-mode matrix re-execution + docs"
```

---

## Refresh notes (2026-07-29)

**Design changes** adopted from the approved spec, which this plan's 2026-07-10 revision predated:

1. **`succeeded` is terminal, not cumulative.** Was `checksSummary.failed === 0`, which scored a run whose iteration-2 failure was fixed by iteration 5 as a failure. Now `terminalFailed === 0`, with `everFailed` retained as churn evidence. Task 8 adds the recovery fixture that pins this.
2. **`summarizeChecks` takes `configuredCount`** so fail-fast short-circuiting surfaces as `skipped` instead of reading as a passing suite.
3. **Fail-fast within a boundary** (new Task 2 behavior) — the ladder stops at the first non-zero exit, including a policy block.
4. **Terminal red gets its own exit reason** (new Task 6), overriding only success reasons so `stopped (budget)` stays legible. Named `"done with failing checks"` — a sentence, matching the existing `NEXT_ACTION` keys — **not** the kebab-case `checks-failed` the spec sketched.
5. **Two-module split** — orchestration moved out of `loop.ts` into `attestation.ts` (new Task 3), because the terminal-state rule is stateful.
6. **One wiring point, not two.** Panel synth attestation needs no new `panel.ts` hook: `panel.ts` already calls the loop's `recordStage` closure for the synth substage, so hooking that closure covers both the single reviewer and the panel synth.

**Anchor corrections** — verified against `main` at `8e33d17`:

| Cited in the old plan                   | Actual on `main`                                              |
| --------------------------------------- | ------------------------------------------------------------- |
| `run-report.ts:114-142` (`StageRecord`) | `run-report.ts:148`                                           |
| `run-report.ts:150-191` (`RunManifest`) | `run-report.ts:225`; `inputSharpness` at `:253`               |
| `inspect.ts:76-81` (sharpness block)    | `inspect.ts:143-148`                                          |
| `inspect.ts:96-100` (skills lines)      | `inspect.ts:163-167`                                          |
| `bench.ts:193-219` (`runFixtureChecks`) | `bench.ts:210`; `CheckRunner` type is at `:193-196`           |
| `loop.ts:810-865` (stage-record write)  | `recordStage` closure at `:775`; record literal at `:800-815` |

Still accurate and reused unchanged: `render.ts:60` (`resolveShell`), `safety-policy.ts:104` (`checkCommand`), `git.ts:44` (`headSha`), `skill-activation.ts:49` (`readSkillsConfig`), `report-finalize.ts:30-36` (`FinalizeReportContext`), `verification-matrix.ts:36-64` / `:49-53` / `:153-179`.
