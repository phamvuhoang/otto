/**
 * Per-run state digest (P30, issue #249 — the P22 retirement slice).
 *
 * Prior-iteration state was carried by re-deriving unbounded blobs every
 * iteration. This writes a compact digest of what the run has established, so
 * late iterations carry bounded state instead of growing evidence.
 *
 * **Harness-written, never agent prose** (spec D4). Every field comes from the
 * manifest and stage records — the same rule P27 applies to `checks` and
 * `artifactExists`. An agent-authored digest would be exactly the unverified
 * self-report Phase 6 exists to eliminate, and it would give an agent a channel
 * to smuggle instructions into the next iteration's prompt.
 *
 * Original evidence stays retrievable in the run bundle; this is a pointer, not
 * a replacement.
 */
import type { StageRecord } from "./run-report.js";

/** Ceiling for the injected digest, mirroring the skills-block budget pattern. */
export const STATE_DIGEST_MAX_CHARS = 1200;

export type StateDigestInput = {
  /** The iteration about to run. */
  iteration: number;
  stages: StageRecord[];
  /** Current task key, when the run has one. */
  taskKey?: string;
  /** Signatures of findings still open, for a count — never pasted in full. */
  openFindings?: string[];
};

/** The most recent attested check state across the run, if P27 recorded any. */
function lastAttested(stages: StageRecord[]): string | null {
  for (let i = stages.length - 1; i >= 0; i--) {
    const checks = stages[i].checks;
    if (!checks || checks.length === 0) continue;
    const failed = checks.filter((c) => c.exitCode !== 0);
    if (failed.length === 0) {
      return `checks green (${checks.length} attested, iteration ${stages[i].iteration})`;
    }
    const sig = failed[0].failureSignature ?? `exit ${failed[0].exitCode}`;
    return `checks RED — ${sig} (iteration ${stages[i].iteration})`;
  }
  return null;
}

/**
 * Build the digest. Returns `""` when there is nothing worth carrying (the
 * first iteration of a fresh run), so injecting it is a no-op there.
 *
 * Truncation is by dropping whole lines, lowest-value last-in first, so the
 * digest never ends mid-fact.
 */
export function buildStateDigest(input: StateDigestInput): string {
  const { iteration, stages, taskKey, openFindings } = input;
  if (stages.length === 0) return "";

  const completed = new Set(stages.map((s) => s.iteration)).size;
  const errored = stages.filter((s) => s.isError).length;

  const lines: string[] = [];
  lines.push(
    `Run state (harness-written): starting iteration ${iteration}; ${completed} completed.`
  );
  if (taskKey) lines.push(`- Current focus: ${taskKey}`);
  const attested = lastAttested(stages);
  if (attested) lines.push(`- Last attested ${attested}`);
  if (openFindings && openFindings.length > 0) {
    lines.push(
      `- ${openFindings.length} review finding(s) still open from earlier iterations.`
    );
  }
  if (errored > 0) lines.push(`- ${errored} stage(s) ended in error.`);
  lines.push(
    "- Full evidence for every iteration is in this run's bundle; reconcile against git before acting."
  );

  let out = lines.join("\n");
  while (out.length > STATE_DIGEST_MAX_CHARS && lines.length > 1) {
    // Drop from the second-to-last upward: the closing reconcile instruction is
    // the actionable line and stays, the header identifies the run and stays.
    lines.splice(lines.length - 2, 1);
    out = lines.join("\n");
  }
  return out.length > STATE_DIGEST_MAX_CHARS
    ? lines[0].slice(0, STATE_DIGEST_MAX_CHARS)
    : out;
}
