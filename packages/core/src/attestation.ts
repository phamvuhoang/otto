/**
 * P27 attestation orchestration.
 *
 * Separate from `checks.ts` because the interesting behavior here is
 * **stateful**: which boundary attested last decides the run's verdict, while
 * the cumulative tally is only evidence. Keeping that state in a module rather
 * than in `loop.ts` locals is what makes it unit-testable without spawning a
 * loop.
 *
 * Spec: `docs/superpowers/specs/2026-07-29-p27-attested-checks-design.md`.
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

/**
 * Exit reasons that mean "the run finished its work". Mirrors `SUCCESS_REASONS`
 * in `eval.ts`; kept local so `attestation.ts` stays free of an eval import.
 */
const SUCCESS_EXIT_REASONS = new Set(["complete", "done"]);

/**
 * Apply the terminal-red exit-reason override (spec D3).
 *
 * The override replaces **only** a success reason. A run that stopped at
 * `stopped (budget)` or `halted (rate limit)` keeps that more informative
 * reason — attestation must not mask why the run actually stopped — and the
 * eval guard (`terminalFailed === 0`) still sinks `succeeded` for it.
 */
export function finalExitReason(
  loopReason: string,
  exitReasonOverride: string | null
): string {
  return exitReasonOverride && SUCCESS_EXIT_REASONS.has(loopReason)
    ? exitReasonOverride
    : loopReason;
}

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
      skipped: cumulative.skipped,
      failureSignatures: cumulative.failureSignatures,
      everFailed: cumulative.failed > 0,
      terminalFailed: terminal.failed,
    },
    exitReasonOverride: terminal.failed > 0 ? CHECKS_FAILED_REASON : null,
  };
}
