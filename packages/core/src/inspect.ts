import { resolve } from "node:path";

import { formatPlainReport } from "./report-explain.js";
import {
  listRunIds,
  readManifest,
  readRunReport,
  readStageRecords,
  type PullRequestReviewEvidence,
  type RunManifest,
  type SkillUsage,
  type StageRecord,
} from "./run-report.js";
import { formatTokenUsage } from "./tokens.js";
import {
  formatVerificationCoverageGate,
  formatVerificationMatrix,
} from "./verification-matrix.js";

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

const USAGE = "Usage: otto-inspect [--plain] [<run-id>|latest]";

/** First 8 hex characters of a full SHA — a git-style short SHA for a
 *  terminal reader; the manifest itself still carries the full value. */
function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** First 12 hex characters of a fingerprint — enough to disambiguate in a
 *  terminal without dumping the full 64-character digest. */
function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

/**
 * Render the compact `Pull request review:` section for a P32
 * `github-pr-review` run (Task 9). SHAs and the review-input fingerprint are
 * SHORTENED here for a terminal reader — the manifest (and the on-disk
 * artifacts it points at) still carry the full values, so nothing is lost.
 *
 * Renders review-input PROVENANCE only (kind/source/fingerprint/artifact
 * path) — never content, so a `direct` prompt's raw untrusted text can never
 * leak into this operator view. Does not use `outcome` to imply the run
 * completed; `exitReason` (printed separately, above) remains authoritative.
 */
function formatPullRequestReviewSection(
  pr: PullRequestReviewEvidence,
  skillsUsed: SkillUsage[] | undefined
): string[] {
  const lines: string[] = [];
  const inputArtifact = pr.reviewInput.artifactPath ?? "(unavailable)";
  lines.push("");
  lines.push("Pull request review:");
  lines.push(`  ${pr.repository}#${pr.pullRequest} (${pr.url})`);
  lines.push(`  label:        ${pr.label}`);
  lines.push(
    `  base/head:    ${shortSha(pr.baseSha)} / ${shortSha(pr.headSha)}`
  );
  lines.push(
    `  review input: ${pr.reviewInput.kind} (${pr.reviewInput.source}), ` +
      `fingerprint ${shortFingerprint(pr.reviewInput.fingerprint)}…, ` +
      `artifact ${inputArtifact}`
  );
  lines.push(`  outcome:      ${pr.outcome ?? "(not yet determined)"}`);
  lines.push(`  confirmed/rejected: ${pr.confirmed} / ${pr.rejected}`);
  lines.push(`  output mode:  ${pr.outputMode}`);

  const receipts: string[] = [pr.githubReview ? "published" : "not published"];
  if (pr.commentId !== undefined) receipts.push(`comment #${pr.commentId}`);
  if (pr.reviewId !== undefined) receipts.push(`review #${pr.reviewId}`);
  lines.push(`  github review: ${receipts.join(", ")}`);

  if (pr.supersededBy !== undefined) {
    lines.push(`  superseded by: ${shortSha(pr.supersededBy)}`);
  }

  const reviewSkill = skillsUsed?.find((u) => u.stage === "pr-review");
  if (reviewSkill?.checksum) {
    lines.push(
      `  skill:        ${reviewSkill.name}@${reviewSkill.version} ` +
        `(checksum ${reviewSkill.checksum})`
    );
  }

  return lines;
}

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
  if (manifest.inputSharpness) {
    const s = manifest.inputSharpness;
    const gaps =
      s.unknowns.length > 0 ? ` — assumed: ${s.unknowns.join(", ")}` : "";
    lines.push(`  sharpness:   ${s.metCount}/${s.maxScore}${gaps}`);
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
    if (s.skillsUsed && s.skillsUsed.length > 0) {
      lines.push(
        `      skills: ${s.skillsUsed.map((u) => `${u.name}${u.source ? ` (${u.source})` : ""}`).join(", ")}`
      );
    }
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

  // Verification gallery (issue #181 P24): the structured matrix a --verify run
  // produced — what was proven, how, and with which artifact — with failures,
  // unproven requirements, and the coverage gate surfaced. A --verify run that
  // recorded no/malformed matrix shows the same visible failure as the report,
  // not nothing (#181 re-review).
  const matrix = manifest.verification ?? [];
  const dropped = manifest.verificationDropped ?? 0;
  if (matrix.length > 0) {
    lines.push("");
    lines.push(formatVerificationMatrix(matrix));
    lines.push("");
    lines.push(
      formatVerificationCoverageGate(matrix, dropped, manifest.verificationPlan)
    );
  } else if (manifest.mode === "verify") {
    lines.push("");
    lines.push(
      `Verification: FAIL — no machine-readable matrix was recorded` +
        (dropped > 0 ? ` (${dropped} malformed row(s) dropped)` : "") +
        "; this run's claims are unproven."
    );
  }

  // Injected skills (issue #114 P18): the validated skills that shaped this run,
  // with attribution, so a reader can trace which guidance influenced the agent.
  if (manifest.skillsUsed && manifest.skillsUsed.length > 0) {
    lines.push("");
    lines.push(`Skills applied (${manifest.skillsUsed.length}):`);
    for (const u of manifest.skillsUsed) {
      const src = u.source
        ? ` from ${u.source}${u.ref ? `@${u.ref}` : ""}`
        : "";
      const at = u.stage ? ` at ${u.stage}` : "";
      lines.push(`  - ${u.name}@${u.version}${src}${at}`);
    }
  }

  // P32 pull-request review evidence (Task 9): additive and optional — only
  // ever present on a finalized `github-pr-review` run.
  if (manifest.pullRequestReview) {
    lines.push(
      ...formatPullRequestReviewSection(
        manifest.pullRequestReview,
        manifest.skillsUsed
      )
    );
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
  // Parse --plain out of argv first; it may appear before or after the run-id.
  const plain = argv.includes("--plain");
  const positional = argv.filter((a) => a !== "--plain");

  const arg = positional[0];
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

  if (plain) {
    deps.out(formatPlainReport(manifest, readRunReport(workspaceDir, runId)));
  } else {
    deps.out(formatRunReport(manifest, readStageRecords(workspaceDir, runId)));
  }
  return 0;
}
