import { resolve } from "node:path";

import {
  listRunIds,
  readManifest,
  runsDir,
  type RunManifest,
} from "./run-report.js";

/**
 * Injectable host surface for {@link runRuns} so the bin stays unit-testable
 * without touching the real cwd/env or process stdio (mirrors `InspectDeps`).
 */
export type RunsDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
};

const defaultDeps: RunsDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
};

const USAGE = "Usage: otto-runs [list]";

/**
 * One row of the `otto-runs list` table — the operator's at-a-glance summary of a
 * recorded run, derived purely from its {@link RunManifest}.
 */
export type RunSummary = {
  runId: string;
  bin: string;
  mode: string;
  /** Terminal exit reason, or "in progress" when the manifest is un-finalized. */
  status: string;
  /** "<completed>/<planned>" iterations, with "?" when completion is unknown. */
  iterations: string;
  costUsd: number;
  /** Wall-clock run duration in ms, or null when it cannot be computed. */
  elapsedMs: number | null;
};

function elapsedMsOf(m: RunManifest): number | null {
  if (m.finishedAt == null) return null;
  const start = Date.parse(m.startedAt);
  const end = Date.parse(m.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

/** Derive an operator {@link RunSummary} from a run manifest. Pure. */
export function summarizeManifest(m: RunManifest): RunSummary {
  return {
    runId: m.runId,
    bin: m.bin,
    mode: m.mode,
    status: m.finishedAt == null ? "in progress" : (m.exitReason ?? "(unknown)"),
    iterations:
      m.completedIterations != null
        ? `${m.completedIterations}/${m.iterations}`
        : `?/${m.iterations}`,
    costUsd: m.costUsd,
    elapsedMs: elapsedMsOf(m),
  };
}

/** Human elapsed: "1m23s" / "12s" / "—" when unknown. */
function formatElapsed(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * Render a list of {@link RunSummary} (newest first) into a compact, fixed-column
 * operator table. Pure: takes already-read summaries, returns the string. Empty
 * list → a friendly "no runs" line so the caller never prints a bare header.
 */
export function formatRunsList(summaries: RunSummary[]): string {
  if (summaries.length === 0) {
    return "No runs recorded yet. Run Otto first; each run writes a bundle under .otto/runs/.";
  }
  const header = ["RUN ID", "BIN", "MODE", "STATUS", "ITERS", "COST", "ELAPSED"];
  // Width per column = max of header + cells, so columns stay aligned.
  const rows = summaries.map((s) => [
    s.runId,
    s.bin,
    s.mode,
    s.status,
    s.iterations,
    `$${s.costUsd.toFixed(2)}`,
    formatElapsed(s.elapsedMs),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => padEnd(c, widths[i])).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/**
 * Drive the `otto-runs` command. The sole subcommand `list` (also the default
 * no-arg) prints a one-row-per-run summary table, newest first, over the bundles
 * under `.otto/runs/`. Read-only; resolves to the process exit code (mirrors
 * `runInspect`/`runMemory`).
 */
export async function runRuns(
  argv: string[],
  deps: RunsDeps = defaultDeps
): Promise<number> {
  const arg = argv[0];
  if (arg === "-h" || arg === "--help") {
    deps.out(USAGE);
    return 0;
  }
  if (arg !== undefined && arg !== "list") {
    deps.err(`Unknown subcommand '${arg}'.\n${USAGE}`);
    return 1;
  }

  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);
  // Newest first: listRunIds is sorted ascending (latest last), so reverse.
  const ids = listRunIds(workspaceDir).reverse();
  const summaries = ids
    .map((id) => readManifest(workspaceDir, id))
    .filter((m): m is RunManifest => m != null)
    .map(summarizeManifest);

  deps.out(`Otto runs (${runsDir(workspaceDir)})`);
  deps.out(formatRunsList(summaries));
  return 0;
}
