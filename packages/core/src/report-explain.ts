import { resolve } from "node:path";

import {
  listRunIds,
  readManifest,
  readRunReport,
  type RunManifest,
} from "./run-report.js";

/**
 * Injectable host surface for {@link runExplain} so the reader stays
 * unit-testable without touching the real cwd/env or process stdio. Mirrors
 * {@link import("./inspect.js").InspectDeps}.
 */
export type ExplainDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
};

const defaultDeps: ExplainDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
};

const USAGE = "Usage: otto-explain [<run-id>|latest]";

/**
 * Render one run for a non-engineer (P9 #64): the plain-language report the run
 * emitted, then a compact "run facts" footer (source, iterations, cost) from the
 * manifest. Pure — takes the already-read manifest and the persisted report text
 * (or `null` when the run emitted none), returns the report string.
 *
 * The persisted report already leads with the layperson prose (What changed /
 * Why / How to verify / What to watch) and keeps engineer detail below its own
 * divider, so this surface is mostly the report plus the run's bottom-line facts.
 * When no report was persisted (an older run, or plan/PRD `afk` mode, which emits
 * none), it falls back to the facts with a one-line note explaining the absence.
 */
export function formatPlainReport(
  manifest: RunManifest,
  reportText: string | null
): string {
  const completed =
    manifest.completedIterations != null
      ? `${manifest.completedIterations} of ${manifest.iterations}`
      : `${manifest.iterations}`;

  const facts: string[] = [];
  facts.push("— Run facts ————————————————————————————");
  facts.push(`  What ran:    ${manifest.bin} (${manifest.mode} mode)`);
  facts.push(`  Asked to do: ${manifest.inputs || "(no inputs)"}`);
  facts.push(`  Effort:      ${completed} iterations · $${manifest.costUsd.toFixed(2)}`);
  if (manifest.exitReason) {
    facts.push(`  Outcome:     ${manifest.exitReason}`);
  }

  const lines: string[] = [];
  if (reportText) {
    lines.push(reportText.trimEnd());
    lines.push("");
    lines.push(...facts);
  } else {
    lines.push(`Run ${manifest.runId}`);
    lines.push("");
    lines.push(
      "This run didn't emit a plain-language report — it's an older run, or a " +
        "plan/PRD (afk) run, which doesn't produce one yet. The run facts:"
    );
    lines.push("");
    lines.push(...facts);
  }
  return lines.join("\n");
}

/**
 * Drive the `otto-explain` command: resolve a run id (an explicit id, or
 * `latest`/no arg → the most recent run under `.otto/runs/`), read its bundle,
 * and print the plain-language report for a non-engineer. Resolves to the
 * process exit code. Mirrors {@link import("./inspect.js").runInspect}.
 */
export async function runExplain(
  argv: string[],
  deps: ExplainDeps = defaultDeps
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
          "Run Otto first, then explain the bundle it writes."
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

  deps.out(formatPlainReport(manifest, readRunReport(workspaceDir, runId)));
  return 0;
}
