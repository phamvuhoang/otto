import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatRunReport, runInspect } from "../inspect.js";
import {
  writeManifest,
  writeRunReport,
  writeStageRecord,
  type PullRequestReviewEvidence,
  type RunManifest,
  type StageRecord,
} from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-inspect-"));
}

const finalized: RunManifest = {
  runId: "2026-06-19T00-00-00-000Z-13793",
  bin: "otto-ghafk",
  mode: "ghafk",
  inputs: "39",
  runtime: { id: "claude", displayName: "Claude Code" },
  branchStrategy: "branch",
  iterations: 5,
  completedIterations: 2,
  costUsd: 1.23,
  tokenUsage: { ...emptyTokenUsage(), inputTokens: 100, outputTokens: 50 },
  exitReason: "complete",
  nextAction: "review the diff, then open a PR",
  artifacts: [
    { kind: "logs", path: ".otto-tmp/logs", description: "raw NDJSON logs" },
    { kind: "review-followups", path: ".otto/review-followups.md" },
  ],
  startedAt: "2026-06-19T00:00:00.000Z",
  finishedAt: "2026-06-19T00:05:00.000Z",
};

const implStage: StageRecord = {
  iteration: 1,
  stage: "implementer",
  runtimeId: "claude",
  costUsd: 0.42,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-06-19T00:00:00.000Z",
  finishedAt: "2026-06-19T00:01:00.000Z",
};

const reviewerStage: StageRecord = {
  ...implStage,
  stage: "reviewer",
  costUsd: 0.1,
  isError: true,
  apiErrorStatus: "429",
  finishedAt: "2026-06-19T00:02:00.000Z",
};

const pullRequestReview: PullRequestReviewEvidence = {
  repository: "acme/widgets",
  pullRequest: 42,
  url: "https://github.com/acme/widgets/pull/42",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  label: "otto-review",
  reviewInput: {
    kind: "prompt",
    source: "direct",
    fingerprint: "c".repeat(64),
    artifactPath: ".otto/runs/2026-06-19T00-00-00-000Z-13793/review-input.txt",
  },
  outcome: "changes-requested",
  confirmed: 2,
  rejected: 1,
  outputMode: "comment",
  githubReview: true,
  commentId: 555,
  reviewId: 999,
  supersededBy: "d".repeat(40),
};

describe("formatRunReport", () => {
  it("answers what happened and why Otto stopped", () => {
    const out = formatRunReport(finalized, [implStage, reviewerStage]);
    // Identity + why it stopped.
    expect(out).toContain("2026-06-19T00-00-00-000Z-13793");
    expect(out).toContain("otto-ghafk");
    expect(out).toContain("ghafk");
    expect(out).toContain("Claude Code");
    expect(out).toContain("complete");
    expect(out).toContain("review the diff, then open a PR");
    // Spend + progress.
    expect(out).toContain("$1.23");
    expect(out).toContain("2 / 5");
    // Stages, with the errored one flagged.
    expect(out).toContain("implementer");
    expect(out).toContain("reviewer");
    expect(out).toContain("429");
    // Artifacts.
    expect(out).toContain(".otto-tmp/logs");
    expect(out).toContain(".otto/review-followups.md");
  });

  it("surfaces the input-sharpness assessment and the assumed gaps (#180 P23)", () => {
    const manifest: RunManifest = {
      ...finalized,
      inputSharpness: {
        metCount: 2,
        maxScore: 5,
        unknowns: ["Constraints / requirements", "Scope / non-goals"],
      },
    };
    const out = formatRunReport(manifest, [implStage]);
    expect(out).toMatch(/sharpness:\s*2\/5/);
    expect(out).toContain("Constraints / requirements");
    expect(out).toContain("Scope / non-goals");
  });

  it("omits the sharpness line when no assessment was recorded (#180 P23)", () => {
    const out = formatRunReport(finalized, [implStage]);
    expect(out).not.toMatch(/sharpness:/);
  });

  it("renders the verification gallery with risks from a --verify run (#181 P24)", () => {
    const manifest: RunManifest = {
      ...finalized,
      mode: "verify",
      verification: [
        {
          requirement: "totalMinutes handles hours",
          method: "test",
          check: "node --test",
          artifactPath: "duration.test.ts:12",
          result: "pass",
          confidence: "high",
        },
        {
          requirement: "rounding is correct",
          method: "inspection",
          check: "read code",
          result: "fail",
          confidence: "low",
        },
      ],
    };
    const out = formatRunReport(manifest, [implStage]);
    expect(out).toMatch(/verification/i);
    expect(out).toContain("totalMinutes handles hours");
    expect(out).toContain("duration.test.ts:12");
    // The failed requirement is surfaced as a risk, not buried.
    expect(out.toLowerCase()).toContain("risk");
    expect(out).toContain("rounding is correct");
  });

  it("omits the verification gallery for a non-verify run with no matrix (#181 P24)", () => {
    const out = formatRunReport(finalized, [implStage]);
    expect(out).not.toMatch(/Verification:/);
  });

  it("shows a visible FAIL in otto-inspect when a --verify run recorded no matrix (#181 re-review)", () => {
    const out = formatRunReport(
      { ...finalized, mode: "verify", verificationDropped: 2 },
      [implStage]
    );
    expect(out).toMatch(/Verification:\s*FAIL/);
    expect(out).toMatch(/no machine-readable matrix/i);
    expect(out).toMatch(/2 malformed/i);
  });

  it("shows the coverage gate in otto-inspect for a verify run with a matrix (#181 re-review)", () => {
    const out = formatRunReport(
      {
        ...finalized,
        mode: "verify",
        verification: [
          {
            requirement: "covered",
            method: "test",
            check: "node --test",
            artifactPath: "x.test.ts:1",
            result: "pass",
            confidence: "high",
          },
        ],
      },
      [implStage]
    );
    expect(out).toContain("Verification Coverage Gate");
  });

  it("surfaces injected skills per stage and in a run-level section (P18)", () => {
    const withSkill: StageRecord = {
      ...implStage,
      skillsUsed: [
        {
          name: "tdd",
          version: "1.0.0",
          source: "superpowers",
          ref: "abc1234",
          stage: "implementer",
          reasons: ["afk-safe (usable on any stage)"],
        },
      ],
    };
    const manifest: RunManifest = {
      ...finalized,
      skillsUsed: [
        {
          name: "tdd",
          version: "1.0.0",
          source: "superpowers",
          stage: "implementer",
        },
      ],
    };
    const out = formatRunReport(manifest, [withSkill, reviewerStage]);
    expect(out).toMatch(/skills/i);
    expect(out).toContain("tdd");
    expect(out).toContain("superpowers");
  });

  it("marks an un-finalized manifest instead of inventing an exit reason", () => {
    const initial: RunManifest = {
      ...finalized,
      completedIterations: undefined,
      exitReason: undefined,
      nextAction: undefined,
      finishedAt: undefined,
      costUsd: 0,
      artifacts: [],
    };
    const out = formatRunReport(initial, []);
    expect(out).toMatch(/not finalized|in progress/i);
    // No exit reason / next action invented for a run that never finalized.
    expect(out).not.toContain("exit:");
    expect(out).not.toContain("review the diff");
  });

  describe("pull request review evidence (P32 Task 9)", () => {
    it("prints a compact 'Pull request review:' section when evidence is present", () => {
      const manifest: RunManifest = {
        ...finalized,
        mode: "github-pr-review",
        pullRequestReview,
        skillsUsed: [
          {
            name: "builtin:otto-code-review",
            version: "1",
            source: "builtin",
            stage: "pr-review",
            checksum: "e".repeat(64),
          },
        ],
      };
      const out = formatRunReport(manifest, [implStage]);

      expect(out).toContain("Pull request review:");
      expect(out).toContain("acme/widgets#42");
      expect(out).toContain(pullRequestReview.url);
      expect(out).toContain(pullRequestReview.label);

      // Base/head SHAs are SHORTENED in the header...
      expect(out).toContain(pullRequestReview.baseSha.slice(0, 8));
      expect(out).toContain(pullRequestReview.headSha.slice(0, 8));
      // ...but the full 40-char SHAs never appear in the rendered text.
      expect(out).not.toContain(pullRequestReview.baseSha);
      expect(out).not.toContain(pullRequestReview.headSha);

      // Review-input kind/source/SHORT fingerprint/artifact.
      expect(out).toContain("prompt");
      expect(out).toContain("direct");
      expect(out).toContain(
        pullRequestReview.reviewInput.fingerprint.slice(0, 12)
      );
      expect(out).not.toContain(pullRequestReview.reviewInput.fingerprint);
      expect(out).toContain(pullRequestReview.reviewInput.artifactPath);

      // Outcome, confirmed/rejected counts, output mode.
      expect(out).toContain("changes-requested");
      expect(out).toContain("2 / 1");
      expect(out).toContain("comment");

      // Comment/review receipts and superseding SHA (shortened).
      expect(out).toContain("555");
      expect(out).toContain("999");
      expect(out).toContain(pullRequestReview.supersededBy!.slice(0, 8));
      expect(out).not.toContain(pullRequestReview.supersededBy);

      // The selected skill's checksum.
      expect(out).toContain("builtin:otto-code-review");
      expect(out).toContain("e".repeat(64));
    });

    it("omits the section entirely when no evidence is present (non-P32 manifest)", () => {
      const out = formatRunReport(finalized, [implStage, reviewerStage]);
      expect(out).not.toContain("Pull request review:");
    });

    it("does not infer run completion from outcome alone — exitReason stays authoritative", () => {
      const manifest: RunManifest = {
        ...finalized,
        mode: "github-pr-review",
        exitReason: "error",
        pullRequestReview: { ...pullRequestReview, outcome: "approved" },
      };
      const out = formatRunReport(manifest, [implStage]);
      // exitReason ("error") remains the reported exit, independent of the
      // review outcome ("approved") — the section reports both, neither hides
      // the other.
      expect(out).toContain("exit:        error");
      expect(out).toContain("approved");
    });
  });
});

describe("runInspect", () => {
  function deps(cwd: string) {
    const lines: string[] = [];
    const errs: string[] = [];
    return {
      d: {
        env: { OTTO_WORKSPACE: cwd } as NodeJS.ProcessEnv,
        cwd,
        out: (m: string) => lines.push(m),
        err: (m: string) => errs.push(m),
      },
      lines,
      errs,
    };
  }

  it("renders an explicit run-id and exits 0", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    writeStageRecord(ws, finalized.runId, 0, implStage);
    const { d, lines } = deps(ws);
    const code = await runInspect([finalized.runId], d);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("complete");
  });

  it("defaults to the latest run when given no arg or 'latest'", async () => {
    const ws = tmp();
    const older: RunManifest = {
      ...finalized,
      runId: "2026-06-19T00-00-00-000Z-1",
      exitReason: "aborted",
    };
    const newer: RunManifest = {
      ...finalized,
      runId: "2026-06-19T09-00-00-000Z-1",
      exitReason: "complete",
    };
    writeManifest(ws, older);
    writeManifest(ws, newer);

    const a = deps(ws);
    expect(await runInspect([], a.d)).toBe(0);
    expect(a.lines.join("\n")).toContain(newer.runId);

    const b = deps(ws);
    expect(await runInspect(["latest"], b.d)).toBe(0);
    expect(b.lines.join("\n")).toContain(newer.runId);
  });

  it("errors when the run-id is unknown", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    const { d, errs } = deps(ws);
    const code = await runInspect(["does-not-exist"], d);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/does-not-exist/);
  });

  it("errors when there are no runs at all", async () => {
    const { d, errs } = deps(tmp());
    const code = await runInspect([], d);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/no runs/i);
  });

  it("--plain with an explicit id prints the plain report and exits 0", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    writeRunReport(ws, finalized.runId, "# Otto quality report\nAll good.\n");
    const { d, lines } = deps(ws);
    const code = await runInspect(["--plain", finalized.runId], d);
    expect(code).toBe(0);
    const out = lines.join("\n");
    // plain report contains the persisted prose
    expect(out).toContain("All good.");
    // run-facts footer is present
    expect(out).toContain("Run facts");
    expect(out).toContain("otto-ghafk");
    // engineer detail is NOT the primary render (no stage table)
    expect(out).not.toContain("Stages (");
  });

  it("--plain after the run-id also works (flag may appear anywhere)", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    writeRunReport(ws, finalized.runId, "# Otto quality report\nDone.\n");
    const { d, lines } = deps(ws);
    const code = await runInspect([finalized.runId, "--plain"], d);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Done.");
  });

  it("--plain with no run-id defaults to the latest run", async () => {
    const ws = tmp();
    const older: RunManifest = {
      ...finalized,
      runId: "2026-06-19T00-00-00-000Z-1",
    };
    const newer: RunManifest = {
      ...finalized,
      runId: "2026-06-19T09-00-00-000Z-1",
    };
    writeManifest(ws, older);
    writeManifest(ws, newer);
    writeRunReport(ws, newer.runId, "# Otto quality report\nNewest run.\n");
    const { d, lines } = deps(ws);
    const code = await runInspect(["--plain"], d);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Newest run.");
    // Facts footer identifies the newer run's bin/mode
    expect(out).toContain("otto-ghafk");
  });

  it("--plain with an unknown id still errors and exits 1", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    const { d, errs } = deps(ws);
    const code = await runInspect(["--plain", "does-not-exist"], d);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/does-not-exist/);
  });

  it("--plain falls back gracefully when no report was persisted", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    // No writeRunReport — run emitted no quality report
    const { d, lines } = deps(ws);
    const code = await runInspect(["--plain", finalized.runId], d);
    expect(code).toBe(0);
    // should still print something (fallback message + facts)
    expect(lines.join("\n")).toMatch(/Run facts|no.*report|plain-language/i);
  });

  it("without --plain the engineer report is unchanged (byte-for-byte same path)", async () => {
    const ws = tmp();
    writeManifest(ws, finalized);
    writeStageRecord(ws, finalized.runId, 0, implStage);
    const { d, lines } = deps(ws);
    const code = await runInspect([finalized.runId], d);
    expect(code).toBe(0);
    // Engineer report still has stage table
    expect(lines.join("\n")).toContain("Stages (");
  });
});
