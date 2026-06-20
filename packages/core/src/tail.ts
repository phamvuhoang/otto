import { resolve } from "node:path";

import {
  listRunIds,
  readManifest as defaultReadManifest,
  readStageRecords,
  type RunManifest,
} from "./run-report.js";
import { buildRunView, formatDoneCard, formatLiveTree } from "./run-view.js";

/**
 * Injectable host surface for {@link runTail} so the poller stays
 * unit-testable without real I/O or real waits.
 */
export type TailDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
  /** Async sleep; injectable so tests pass a no-op and never actually wait. */
  sleep: (ms: number) => Promise<void>;
  /** Max poll iterations before giving up (default: 300 = ~5 min at 1s interval). */
  maxPolls?: number;
  /** Injectable manifest reader; defaults to readManifest from run-report.ts. */
  readManifest?: (workspaceDir: string, runId: string) => RunManifest | null;
};

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_MAX_POLLS = 300;

const USAGE = "Usage: otto-tail [<run-id>|latest]";

const defaultDeps: TailDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPolls: DEFAULT_MAX_POLLS,
};

/**
 * Drive the `otto-tail` command: resolve a run id (an explicit id, or
 * `latest`/no arg → the most recent run under `.otto/runs/`), then poll
 * the evidence bundle printing a live tree while running and the done card
 * once finalized. Resolves to the process exit code.
 */
export async function runTail(
  argv: string[],
  deps: TailDeps = defaultDeps
): Promise<number> {
  const arg = argv[0];
  if (arg === "-h" || arg === "--help") {
    deps.out(USAGE);
    return 0;
  }

  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);
  const readMfn = deps.readManifest ?? defaultReadManifest;

  let runId: string;
  if (arg && arg !== "latest") {
    runId = arg;
  } else {
    const ids = listRunIds(workspaceDir);
    if (ids.length === 0) {
      deps.err(
        `No runs found under ${workspaceDir}/.otto/runs/. ` +
          "Run Otto first, then tail the bundle it writes."
      );
      return 1;
    }
    runId = ids[ids.length - 1];
  }

  // Verify the run exists before starting the poll loop.
  const initial = readMfn(workspaceDir, runId);
  if (!initial) {
    deps.err(
      `No manifest for run '${runId}' under ${workspaceDir}/.otto/runs/. ` +
        "Check the run id (or pass `latest`)."
    );
    return 1;
  }

  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  let polls = 0;

  // Poll loop: read manifest+stages, render; stop when finalized or maxPolls hit.
  while (polls < maxPolls) {
    const manifest = readMfn(workspaceDir, runId);
    if (!manifest) {
      // Manifest vanished mid-poll — treat as transient, keep trying.
      await deps.sleep(DEFAULT_INTERVAL_MS);
      polls++;
      continue;
    }

    const stages = readStageRecords(workspaceDir, runId);
    const view = buildRunView(manifest, stages);

    if (manifest.finishedAt != null) {
      deps.out(formatDoneCard(view));
      return 0;
    }

    // Still running — print a live tree frame.
    deps.out(formatLiveTree(view));
    await deps.sleep(DEFAULT_INTERVAL_MS);
    polls++;
  }

  // Reached maxPolls without the run finalizing.
  deps.err(
    `otto-tail: run '${runId}' did not finalize after ${maxPolls} poll(s); giving up.`
  );
  return 1;
}
