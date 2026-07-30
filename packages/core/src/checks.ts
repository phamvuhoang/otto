import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveShell } from "./render.js";
import {
  checkCommand,
  DEFAULT_POLICY,
  type SafetyPolicy,
} from "./safety-policy.js";

/**
 * P27 harness-attested checks — the pure core.
 *
 * The harness executes the repo's configured check commands itself instead of
 * trusting an agent's prose that "the suites pass". This module holds the
 * shared P27/P28 contract: the record shape, failure-signature extraction, and
 * the tally. Orchestration lives in `attestation.ts`.
 *
 * Spec: `docs/superpowers/specs/2026-07-29-p27-attested-checks-design.md`.
 */

/** One harness-executed check command and what the harness observed. */
export type ChecksRecord = {
  command: string;
  /** Process exit code; `-1` for a timeout, spawn failure, or policy block. */
  exitCode: number;
  durationMs: number;
  /** Last `OUTPUT_TAIL_LIMIT` chars of combined stdout+stderr. */
  outputTail: string;
  /** Stable, duration-normalized failure fingerprint; `null` when passing. */
  failureSignature: string | null;
  attestedAt: string;
};

// NOTE: `FAIL(?:ED)?`, not `FAILED?`. The latter binds the `?` to the `D`, so it
// matches "FAILE"/"FAILED" but never the bare "FAIL" that vitest actually prints.
const FAILURE_MARKERS =
  /(\bFAIL(?:ED)?\b|✗|✘|\bERR!\b|\bAssertionError\b|\berror TS\d+\b|\bError\b)/;

/**
 * Strip SGR/CSI escapes so signatures don't vary with terminal colour.
 *
 * The escape is written `\u001b` rather than as a literal control byte on
 * purpose: a raw 0x1b makes `file(1)` classify the source as `data`, which
 * makes `grep`/`ripgrep` skip the whole file silently (see `memory.ts:221-222`
 * for the version of this that already bit us).
 */
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
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
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/**
 * Execute the configured checks in order, **stopping at the first failure**
 * (spec D2): a red typecheck must not pay for the slow suite. Unrun commands
 * are deliberately absent from the result — {@link summarizeChecks} reports
 * them as `skipped` so a short-circuited ladder never reads as a passing suite.
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
