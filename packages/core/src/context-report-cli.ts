import { resolve } from "node:path";

import { listRunIds, readStageRecords, type StageRecord } from "./run-report.js";
import { formatCacheEfficiency, summarizeCacheEfficiency } from "./tokens.js";

/**
 * `otto-afk --context-report` read-only surface (issue #62 P7, slice 3).
 *
 * A pure formatter over the latest run bundle's per-stage context breakdowns
 * (captured in slice 2 — {@link StageRecord.contextBreakdown}), mirroring
 * `otto-runs` / `otto-inspect`: it answers "what filled the window each
 * iteration, and is per-iteration token cost staying bounded?" — the
 * measurement P7's later optimizations are judged against. Read-only; records
 * nothing and runs no stage.
 */

/** Injectable host surface so the bin stays unit-testable (mirrors `RunsDeps`). */
export type ContextReportDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
};

const defaultDeps: ContextReportDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
};

const num = new Intl.NumberFormat("en-US");
const pct = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function avg(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/**
 * Render one run's per-stage context breakdowns into a compact composition +
 * slope report. Pure: takes the already-read stage records, returns the string.
 *
 * - Per measured stage: its estimated tokens and per-category share (largest
 *   first, the order `analyzeContext` already sorts segments by).
 * - Slope: first-third vs last-third average estimated tokens, with a
 *   growing/flat/shrinking label (±10% band) — the "is per-iteration cost
 *   bounded?" signal P7's success metric tracks. `n/a` until ≥2 stages measured.
 */
export function formatContextReportRun(
  runId: string,
  stages: StageRecord[]
): string {
  const lines: string[] = [`Context report — run ${runId}`];
  const measured = stages.filter((s) => s.contextBreakdown != null);
  if (measured.length === 0) {
    lines.push(
      "  No context breakdown recorded for this run. Breakdowns are captured"
    );
    lines.push(
      "  per stage from the P7 slice-2 build onward; older runs have none."
    );
    return lines.join("\n");
  }

  lines.push(`  ${measured.length} stage(s) measured`, "");
  for (const s of measured) {
    const b = s.contextBreakdown!;
    const shares = b.segments
      .map(
        (seg) =>
          `${seg.category} ${pct.format(
            b.totalChars > 0 ? (seg.chars / b.totalChars) * 100 : 0
          )}%`
      )
      .join(" · ");
    lines.push(
      `  iter${s.iteration} ${s.stage}  ~${num.format(b.estimatedTokens)} tokens` +
        (shares ? `  ${shares}` : "")
    );
  }

  lines.push("");
  const toks = measured.map((s) => s.contextBreakdown!.estimatedTokens);
  if (toks.length < 2) {
    lines.push("  Slope: n/a (need ≥2 measured stages)");
  } else {
    const third = Math.max(1, Math.floor(toks.length / 3));
    const firstAvg = avg(toks.slice(0, third));
    const lastAvg = avg(toks.slice(-third));
    const deltaPct = firstAvg > 0 ? ((lastAvg - firstAvg) / firstAvg) * 100 : 0;
    const trend = deltaPct > 10 ? "growing" : deltaPct < -10 ? "shrinking" : "flat";
    lines.push(
      `  Slope (~tokens/stage): first-third avg ~${num.format(
        Math.round(firstAvg)
      )} → last-third avg ~${num.format(Math.round(lastAvg))}  (${
        deltaPct >= 0 ? "+" : ""
      }${pct.format(deltaPct)}%, ${trend})`
    );
  }

  // Cache efficiency (slice 4) — authoritative provider usage, independent of
  // the estimated-token composition above. Drawn from EVERY stage's usage (not
  // just measured ones); omitted when no input tokens were billed.
  const cache = summarizeCacheEfficiency(stages.map((s) => s.usage));
  if (cache.totalInputTokens > 0) {
    lines.push("", `  ${formatCacheEfficiency(cache)}`);
  }
  return lines.join("\n");
}

/**
 * Drive `--context-report`: read the latest run's stage records under
 * `.otto/runs/` and print the composition + slope report. Read-only; resolves
 * to the process exit code (1 only when there is no run to report on).
 */
export async function runContextReport(
  deps: ContextReportDeps = defaultDeps
): Promise<number> {
  const workspaceDir = resolve(deps.env.OTTO_WORKSPACE ?? deps.cwd);
  const ids = listRunIds(workspaceDir);
  if (ids.length === 0) {
    deps.err(
      `No runs found under ${workspaceDir}/.otto/runs/. ` +
        "Run Otto first, then re-run with --context-report."
    );
    return 1;
  }
  const runId = ids[ids.length - 1];
  deps.out(formatContextReportRun(runId, readStageRecords(workspaceDir, runId)));
  return 0;
}
