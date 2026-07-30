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
