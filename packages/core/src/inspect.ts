import { resolve } from "node:path";

import {
  listRunIds,
  readManifest,
  readStageRecords,
  type RunManifest,
  type StageRecord,
} from "./run-report.js";
import { formatTokenUsage } from "./tokens.js";

/**
 * Injectable host surface for {@link runInspect} so the reader stays
 * unit-testable without touching the real cwd/env or process stdio.
 */
export type InspectDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
};

const defaultDeps: InspectDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
};

const USAGE = "Usage: otto-inspect [<run-id>|latest]";

/**
 * Render one run's evidence bundle (manifest + stage records) into a compact,
 * human-readable report answering "what happened and why did Otto stop?". Pure:
 * takes the already-read manifest and stage records, returns the report string.
 */
export function formatRunReport(
  manifest: RunManifest,
  stages: StageRecord[]
): string {
  const finalized = manifest.finishedAt != null;
  const completed =
    manifest.completedIterations != null
      ? `${manifest.completedIterations} / ${manifest.iterations}`
      : `? / ${manifest.iterations}`;

  const lines: string[] = [];
  lines.push(`Otto run ${manifest.runId}`);
  lines.push(`  bin/mode:    ${manifest.bin} / ${manifest.mode}`);
  lines.push(`  inputs:      ${manifest.inputs || "(none)"}`);
  lines.push(
    `  runtime:     ${manifest.runtime.displayName} (${manifest.runtime.id})`
  );
  if (manifest.branchStrategy) {
    lines.push(`  branch:      ${manifest.branchStrategy}`);
  }
  lines.push(`  started:     ${manifest.startedAt}`);
  lines.push(
    `  finished:    ${manifest.finishedAt ?? "(not finalized — in progress or interrupted)"}`
  );
  lines.push(`  iterations:  ${completed} completed`);
  lines.push(`  cost:        $${manifest.costUsd.toFixed(2)}`);
  lines.push(`  tokens:      ${formatTokenUsage(manifest.tokenUsage)}`);
  if (finalized) {
    lines.push(`  exit:        ${manifest.exitReason ?? "(unknown)"}`);
    if (manifest.nextAction) {
      lines.push(`  next:        ${manifest.nextAction}`);
    }
  }

  lines.push("");
  lines.push(`Stages (${stages.length}):`);
  if (stages.length === 0) {
    lines.push("  (none recorded)");
  }
  stages.forEach((s, i) => {
    const status = s.isError
      ? `ERROR${s.apiErrorStatus ? ` ${s.apiErrorStatus}` : ""}`
      : "ok";
    lines.push(
      `  ${String(i + 1).padStart(2)}. iter${s.iteration} ${s.stage}  ` +
        `[${status}]  $${s.costUsd.toFixed(2)}`
    );
  });

  lines.push("");
  lines.push(`Artifacts (${manifest.artifacts.length}):`);
  if (manifest.artifacts.length === 0) {
    lines.push("  (none)");
  }
  for (const a of manifest.artifacts) {
    const desc = a.description ? ` — ${a.description}` : "";
    lines.push(`  - ${a.kind}: ${a.path}${desc}`);
  }

  return lines.join("\n");
}

/**
 * Drive the `otto-inspect` command: resolve a run id (an explicit id, or
 * `latest`/no arg → the most recent run under `.otto/runs/`), read its bundle,
 * and print the human report. Resolves to the process exit code.
 */
export async function runInspect(
  argv: string[],
  deps: InspectDeps = defaultDeps
): Promise<number> {
  const arg = argv[0];
  if (arg === "-h" || arg === "--help") {
    deps.out(USAGE);
    return 0;
  }

  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);

  let runId: string;
  if (arg && arg !== "latest") {
    runId = arg;
  } else {
    const ids = listRunIds(workspaceDir);
    if (ids.length === 0) {
      deps.err(
        `No runs found under ${workspaceDir}/.otto/runs/. ` +
          "Run Otto first, then inspect the bundle it writes."
      );
      return 1;
    }
    runId = ids[ids.length - 1];
  }

  const manifest = readManifest(workspaceDir, runId);
  if (!manifest) {
    deps.err(
      `No manifest for run '${runId}' under ${workspaceDir}/.otto/runs/. ` +
        "Check the run id (or pass `latest`)."
    );
    return 1;
  }

  deps.out(formatRunReport(manifest, readStageRecords(workspaceDir, runId)));
  return 0;
}
