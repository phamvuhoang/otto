import { describe, expect, it } from "vitest";

import {
  buildFallbackRunReport,
  extractRunReport,
  finalizeReportText,
  summarizeReviewSeverity,
} from "../report-finalize.js";
import type { RunManifest, StageRecord } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

const manifest: RunManifest = {
  runId: "run-1",
  bin: "otto-afk",
  mode: "afk",
  inputs: "docs/plan.md docs/prd.md",
  runtime: { id: "claude", displayName: "Claude Code" },
  iterations: 1,
  completedIterations: 1,
  costUsd: 0.12,
  tokenUsage: emptyTokenUsage(),
  exitReason: "complete",
  artifacts: [],
  startedAt: "2026-06-24T00:00:00.000Z",
  finishedAt: "2026-06-24T00:01:00.000Z",
};

const stage: StageRecord = {
  iteration: 1,
  stage: "implementer",
  runtimeId: "claude",
  costUsd: 0.12,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  logPath: ".otto-tmp/logs/iter1-implementer.ndjson",
  reviewSeverity: { blocker: 0, major: 1, minor: 0, nit: 2, suppressed: 2 },
  startedAt: "2026-06-24T00:00:00.000Z",
  finishedAt: "2026-06-24T00:01:00.000Z",
};

const emitted = [
  "# Otto quality report",
  "",
  "## Verdict",
  "",
  "**Needs human review**",
  "",
  "## Why",
  "",
  "The issue asked for this workflow to be safer.",
  "",
  "## How To Verify",
  "",
  "1. Run the tool and check the result.",
  "",
  "## What To Watch",
  "",
  "Nothing notable.",
  "",
  "## What I Was Unsure About",
  "",
  "Nothing.",
  "",
  "---",
  "",
  "_Engineer detail below — a non-engineer can stop reading here._",
  "",
  "## Task Source",
  "",
  "- Mode: afk",
  "",
  "## What Changed",
  "",
  "The loop persists reports.",
  "",
  "## Evidence",
  "",
  "- Manual evidence.",
  "",
  "## Human Acceptance Checklist",
  "",
  "- [ ] Solves the stated problem.",
  "",
  "## Gaps And Follow-Ups",
  "",
  "- Gap: none.",
].join("\n");

describe("extractRunReport", () => {
  it("extracts the report body and strips the completion sentinel", () => {
    const out = extractRunReport(
      `noise\n${emitted}\n<promise>NO MORE TASKS</promise>`
    );
    expect(out).toContain("# Otto quality report");
    expect(out).not.toContain("NO MORE TASKS");
  });
});

describe("finalizeReportText", () => {
  it("adds outcome framing, automatic evidence, severity, and rubric gate", () => {
    const out = finalizeReportText(emitted, {
      manifest,
      stages: [stage],
      headSha: "abc1234",
      changedFiles: ["packages/core/src/loop.ts"],
      scopeDrift: {
        plannedFiles: ["packages/core/src/loop.ts"],
        touchedFiles: ["packages/core/src/loop.ts"],
        outOfScope: [],
      },
    });
    expect(out).toContain("## What You Can Now Do");
    expect(out).toContain("Final HEAD: `abc1234`");
    expect(out).toContain("iter1-implementer.ndjson:1");
    expect(out).toContain("blocker 0, major 1, minor 0, nit 2");
    expect(out).toContain("## Emit-Time Report Rubric");
    expect(out).toContain("Gate: **PASS**");
  });

  it("marks the rubric gate FAIL and appends a rewrite request for a low-legibility report", () => {
    const out = finalizeReportText(
      "# Otto quality report\n\n## Verdict\n\nAccepted\n",
      {
        manifest,
        stages: [stage],
        headSha: "abc1234",
        changedFiles: [],
      }
    );
    expect(out).toContain("## Emit-Time Report Rubric");
    expect(out).toContain("Gate: **FAIL**");
    expect(out).toContain("Rewrite request:");
  });

  it("folds a verification matrix into a Verification Gallery section (#181 P24)", () => {
    const out = finalizeReportText(emitted, {
      manifest: {
        ...manifest,
        mode: "verify",
        verification: [
          {
            requirement: "suite is green",
            method: "test",
            check: "node --test",
            artifactPath: "x.test.ts:1",
            result: "pass",
            confidence: "high",
          },
          {
            requirement: "edge case handled",
            method: "inspection",
            check: "read code",
            result: "fail",
            confidence: "low",
          },
        ],
      },
      stages: [stage],
      headSha: "abc1234",
      changedFiles: [],
    });
    expect(out).toContain("## Verification Gallery");
    expect(out).toContain("suite is green");
    expect(out).toContain("x.test.ts:1");
    // The failed requirement is surfaced as a risk.
    expect(out.toLowerCase()).toContain("risk");
    expect(out).toContain("edge case handled");
    // The coverage gate judges the matrix (a failure ⇒ FAIL) with remediation.
    expect(out).toContain("## Verification Coverage Gate");
    expect(out).toContain("Gate: **FAIL**");
  });

  it("embeds captured screenshots as a Screenshot Evidence gallery (#181 P24 visual)", () => {
    const out = finalizeReportText(emitted, {
      manifest: {
        ...manifest,
        mode: "verify",
        verification: [
          {
            requirement: "settings page renders",
            method: "visual",
            check: "screenshot the rendered page",
            beforePath: "verification/0-before.png",
            artifactPath: "verification/1-after.png",
            result: "pass",
            confidence: "high",
          },
        ],
      },
      stages: [stage],
      headSha: "abc1234",
      changedFiles: [],
    });
    expect(out).toContain("## Screenshot Evidence");
    expect(out).toContain("![before](verification/0-before.png)");
    expect(out).toContain("![after](verification/1-after.png)");
  });

  it("adds no gallery when a non-verify run carried no verification matrix (#181 P24)", () => {
    const out = finalizeReportText(emitted, {
      manifest,
      stages: [stage],
      headSha: "abc1234",
      changedFiles: [],
    });
    expect(out).not.toContain("## Verification Gallery");
    expect(out).not.toContain("## Verification Coverage Gate");
  });

  it("FAILs the gate when a valid passing matrix has a dropped row (#181 re-review)", () => {
    const out = finalizeReportText(emitted, {
      manifest: {
        ...manifest,
        mode: "verify",
        verificationDropped: 1,
        verification: [
          {
            requirement: "suite is green",
            method: "test",
            check: "node --test",
            artifactPath: "x.test.ts:1",
            result: "pass",
            confidence: "high",
          },
        ],
      },
      stages: [stage],
      headSha: "abc1234",
      changedFiles: [],
    });
    expect(out).toContain("## Verification Coverage Gate");
    expect(out).toContain("Gate: **FAIL**");
    expect(out).toMatch(/dropped 1 malformed/i);
  });

  it("shows a FAIL gate when a --verify run recorded no valid matrix (#181 review)", () => {
    const out = finalizeReportText(emitted, {
      manifest: { ...manifest, mode: "verify", verificationDropped: 2 },
      stages: [stage],
      headSha: "abc1234",
      changedFiles: [],
    });
    expect(out).toContain("## Verification Coverage Gate");
    expect(out).toContain("Gate: **FAIL**");
    // The dropped malformed rows are surfaced, not hidden.
    expect(out).toContain("2 malformed matrix row(s) were dropped");
  });

  it("generates a fallback report when the agent emitted none", () => {
    const out = buildFallbackRunReport({
      manifest,
      stages: [stage],
      headSha: "abc1234",
      changedFiles: [],
    });
    expect(out).toContain("## What You Can Now Do");
    expect(out).toContain("Needs human review");
    expect(out).toContain("model-authored report was missing");
  });
});

describe("summarizeReviewSeverity", () => {
  it("returns null when no review severity was recorded", () => {
    expect(
      summarizeReviewSeverity([{ ...stage, reviewSeverity: undefined }])
    ).toBeNull();
  });

  it("adds counts across review stages", () => {
    expect(summarizeReviewSeverity([stage, stage])).toMatchObject({
      major: 2,
      nit: 4,
      suppressed: 4,
    });
  });
});
