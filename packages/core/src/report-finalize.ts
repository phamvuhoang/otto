import { formatReportRubric, scoreReportLegibility } from "./report-rubric.js";
import {
  REPORT_MARKER,
  type RunManifest,
  type StageRecord,
} from "./run-report.js";
import {
  formatVerificationCoverageGate,
  formatVerificationMatrix,
} from "./verification-matrix.js";

const SENTINEL_RE = /\n?<promise>NO MORE TASKS<\/promise>\s*/g;
const H2_RE = /^##\s+/m;

export type ReviewSeveritySummary = {
  blocker: number;
  major: number;
  minor: number;
  nit: number;
  suppressed: number;
};

export type ScopeDriftSummary = {
  plannedFiles: string[];
  touchedFiles: string[];
  outOfScope: string[];
};

export type FinalizeReportContext = {
  manifest: RunManifest;
  stages: StageRecord[];
  headSha?: string | null;
  changedFiles?: string[];
  scopeDrift?: ScopeDriftSummary | null;
};

export const DEFAULT_REPORT_LEGIBILITY_THRESHOLD = 1;

export function extractRunReport(stageResult: string): string | null {
  const start = stageResult.indexOf(REPORT_MARKER);
  if (start < 0) return null;
  return stageResult.slice(start).replace(SENTINEL_RE, "").trimEnd() + "\n";
}

function stageLogRefs(stages: StageRecord[]): string[] {
  return stages
    .filter((s) => s.logPath)
    .map(
      (s) =>
        `- Stage log: \`${s.logPath}:1\` (${s.stage}, iteration ${s.iteration})`
    );
}

export function summarizeReviewSeverity(
  stages: StageRecord[]
): ReviewSeveritySummary | null {
  const summary: ReviewSeveritySummary = {
    blocker: 0,
    major: 0,
    minor: 0,
    nit: 0,
    suppressed: 0,
  };
  let seen = false;
  for (const stage of stages) {
    if (!stage.reviewSeverity) continue;
    seen = true;
    summary.blocker += stage.reviewSeverity.blocker;
    summary.major += stage.reviewSeverity.major;
    summary.minor += stage.reviewSeverity.minor;
    summary.nit += stage.reviewSeverity.nit;
    summary.suppressed += stage.reviewSeverity.suppressed;
  }
  return seen ? summary : null;
}

function severitySentence(summary: ReviewSeveritySummary | null): string {
  if (!summary) {
    return "No review-panel severity data was recorded for this run.";
  }
  const high = summary.blocker + summary.major;
  if (high > 0) {
    return `Automated review recorded ${summary.blocker} blocker and ${summary.major} major finding(s); review the engineer evidence before accepting.`;
  }
  if (summary.minor + summary.nit > 0) {
    return `Automated review recorded no blockers or major findings; ${summary.minor} minor and ${summary.nit} nit finding(s) were tracked.`;
  }
  return "Automated review recorded no blocker, major, minor, or nit findings.";
}

function scopeSentence(scopeDrift?: ScopeDriftSummary | null): string {
  if (!scopeDrift) return "";
  if (scopeDrift.outOfScope.length === 0) {
    return "Touched files stayed inside the authored plan file map.";
  }
  return `Scope drift flagged: ${scopeDrift.outOfScope.length} touched file(s) were outside the authored plan file map.`;
}

function insertSectionAfter(
  report: string,
  anchorHeading: string,
  section: string
): string {
  const anchor = new RegExp(
    `^${anchorHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "m"
  );
  const match = anchor.exec(report);
  if (!match) return `${report.trimEnd()}\n\n${section.trimEnd()}\n`;
  const afterAnchor = match.index + match[0].length;
  const rest = report.slice(afterAnchor);
  const next = H2_RE.exec(rest);
  const insertAt = next ? afterAnchor + next.index : report.length;
  return `${report.slice(0, insertAt).trimEnd()}\n\n${section.trimEnd()}\n\n${report.slice(insertAt).trimStart()}`;
}

function ensureOutcomeSection(report: string, manifest: RunManifest): string {
  if (/^##\s+What You Can Now Do\s*$/m.test(report)) return report;
  const task = manifest.inputs || `${manifest.bin} ${manifest.mode}`;
  const section = [
    "## What You Can Now Do",
    "",
    `Use this handoff to decide whether the requested work (${task}) is ready to accept. The emitted report did not include an outcome-first section, so verify the evidence below before accepting it.`,
  ].join("\n");
  return insertSectionAfter(report, "## Verdict", section);
}

function insertRiskNotes(
  report: string,
  severity: ReviewSeveritySummary | null,
  scopeDrift?: ScopeDriftSummary | null
): string {
  const scope = scopeSentence(scopeDrift);
  const watchNote = `Automated risk note: ${[severitySentence(severity), scope]
    .filter(Boolean)
    .join(" ")}`;
  let out = insertSectionAfter(
    report,
    "## What To Watch",
    ["", watchNote].join("\n")
  );
  if (scopeDrift && scopeDrift.outOfScope.length > 0) {
    out = insertSectionAfter(
      out,
      "## What I Was Unsure About",
      [
        "",
        `Automated uncertainty: ${scopeDrift.outOfScope.length} file(s) were touched outside the plan file map; confirm that scope expansion was intentional.`,
      ].join("\n")
    );
  }
  return out;
}

function automaticEvidenceLines(ctx: FinalizeReportContext): string[] {
  const lines: string[] = [];
  if (ctx.headSha) lines.push(`- Final HEAD: \`${ctx.headSha}\``);
  const changed = ctx.changedFiles ?? [];
  if (changed.length > 0) {
    lines.push(
      `- Changed files from run start: ${changed.map((f) => `\`${f}\``).join(", ")}`
    );
  } else {
    lines.push("- Changed files from run start: none recorded.");
  }
  lines.push(...stageLogRefs(ctx.stages));
  const severity = summarizeReviewSeverity(ctx.stages);
  if (severity) {
    lines.push(
      `- Review severity counts: blocker ${severity.blocker}, major ${severity.major}, minor ${severity.minor}, nit ${severity.nit}, suppressed ${severity.suppressed}.`
    );
  }
  if (ctx.scopeDrift) {
    if (ctx.scopeDrift.outOfScope.length === 0) {
      lines.push(
        "- Scope drift: none detected against the latest plan file map."
      );
    } else {
      lines.push(
        `- Scope drift: out-of-plan files ${ctx.scopeDrift.outOfScope
          .map((f) => `\`${f}\``)
          .join(", ")}.`
      );
    }
  }
  return lines;
}

function appendAutomatedEvidence(
  report: string,
  ctx: FinalizeReportContext
): string {
  const section = [
    "## Automated Evidence",
    "",
    ...automaticEvidenceLines(ctx),
  ].join("\n");
  return `${report.trimEnd()}\n\n${section}\n`;
}

/**
 * Fold a `--verify` run's structured verification matrix into the run report as a
 * "Verification Gallery" section (issue #181 P24) — so a maintainer reading the
 * plain report, not just `otto-inspect`, sees what was proven, how, and with
 * which artifact, with failures/unproven requirements surfaced as risks. No-op
 * when the run carried no matrix, so non-verify reports are unchanged.
 */
function appendVerificationGallery(
  report: string,
  ctx: FinalizeReportContext
): string {
  const matrix = ctx.manifest.verification;
  if (!matrix || matrix.length === 0) return report;
  const section = [
    "## Verification Gallery",
    "",
    "Structured proof that each requirement was checked — its method, result, and the artifact that backs it. Failed or unproven requirements are listed as risks below the matrix.",
    "",
    "```text",
    formatVerificationMatrix(matrix),
    "```",
    "",
    // Coverage gate (P24): judge whether every verifiable requirement is
    // artifact-backed — the roadmap's "reports include a verification artifact
    // where feasible" bar — with remediation on FAIL.
    formatVerificationCoverageGate(matrix),
  ].join("\n");
  return `${report.trimEnd()}\n\n${section}\n`;
}

function appendLegibilityGate(report: string): string {
  const score = scoreReportLegibility(report);
  const passed = score.ratio >= DEFAULT_REPORT_LEGIBILITY_THRESHOLD;
  const lines = [
    "## Emit-Time Report Rubric",
    "",
    `Gate: **${passed ? "PASS" : "FAIL"}**`,
    "",
    "```text",
    formatReportRubric(score),
    "```",
  ];
  if (!passed) {
    lines.push(
      "",
      `Rewrite request: revise the report before handoff by adding ${score.missing.join(", ")}.`
    );
  }
  return `${report.trimEnd()}\n\n${lines.join("\n")}\n`;
}

export function buildFallbackRunReport(ctx: FinalizeReportContext): string {
  const severity = summarizeReviewSeverity(ctx.stages);
  const task = ctx.manifest.inputs || "(no explicit input)";
  return [
    REPORT_MARKER,
    "",
    "## Verdict",
    "",
    "**Needs human review** — Otto did not emit a model-authored quality report, so this harness-generated handoff is evidence-first.",
    "",
    "## What You Can Now Do",
    "",
    `Review whether the requested work (${task}) is ready to accept using the run facts and automated evidence below.`,
    "",
    "## Why",
    "",
    "Every run should leave a readable handoff, even when the agent finishes without writing one.",
    "",
    "## How To Verify",
    "",
    "1. Open the evidence bundle path listed under Automated Evidence.",
    "2. Check the final commit and stage logs listed there; accept only if they match the requested outcome.",
    "",
    "## What To Watch",
    "",
    severitySentence(severity),
    scopeSentence(ctx.scopeDrift) ||
      "No scope-drift check was available for this run.",
    "",
    "## What I Was Unsure About",
    "",
    "The agent did not provide its own plain-language summary, so the user-facing outcome still needs human confirmation.",
    "",
    "---",
    "",
    "_Engineer detail below — a non-engineer can stop reading here._",
    "",
    "## Task Source",
    "",
    `- Mode: ${ctx.manifest.mode}`,
    `- Source: ${ctx.manifest.inputs || "(no inputs)"}`,
    `- Issue or plan: ${ctx.manifest.inputs || "(none)"}`,
    "",
    "## What Changed",
    "",
    "The harness can identify the final commit and changed files, but no model-authored change summary was emitted.",
    "",
    "## Evidence",
    "",
    ...automaticEvidenceLines(ctx),
    "",
    "## Human Acceptance Checklist",
    "",
    "- [ ] Solves the stated problem.",
    "- [ ] Behavior is observable or explained.",
    "- [ ] Scope is appropriate.",
    "- [ ] Docs/examples are updated when needed.",
    "- [ ] Risks and assumptions are clear.",
    "",
    "## Gaps And Follow-Ups",
    "",
    "- Gap: model-authored report was missing.",
    "- Deferred: none recorded by the harness.",
    "- Recommended next action: review the evidence bundle before accepting the run.",
    "",
  ].join("\n");
}

export function finalizeReportText(
  reportText: string | null,
  ctx: FinalizeReportContext
): string {
  const base = reportText ? reportText : buildFallbackRunReport(ctx);
  const withOutcome = ensureOutcomeSection(base, ctx.manifest);
  const withRisk = insertRiskNotes(
    withOutcome,
    summarizeReviewSeverity(ctx.stages),
    ctx.scopeDrift
  );
  const withEvidence = appendAutomatedEvidence(withRisk, ctx);
  const withGallery = appendVerificationGallery(withEvidence, ctx);
  return appendLegibilityGate(withGallery);
}
