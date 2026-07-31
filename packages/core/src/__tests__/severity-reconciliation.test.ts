import { describe, expect, it } from "vitest";
import { summarizeReviewSeverity } from "../report-finalize.js";
import type { StageRecord } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

const stage = (
  name: string,
  severity?: StageRecord["reviewSeverity"]
): StageRecord => ({
  iteration: 1,
  stage: name,
  runtimeId: "claude",
  costUsd: 0,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-07-31T00:00:00.000Z",
  finishedAt: "2026-07-31T00:01:00.000Z",
  ...(severity ? { reviewSeverity: severity } : {}),
});

const counts = (
  over: Partial<NonNullable<StageRecord["reviewSeverity"]>> = {}
) => ({
  blocker: 0,
  major: 0,
  minor: 0,
  nit: 0,
  suppressed: 0,
  ...over,
});

describe("summarizeReviewSeverity reconciles with verifier verdicts", () => {
  it("does not double-count a panel run's verify AND synth records", () => {
    // panel.ts records severity twice per run: candidates at the verify
    // substage, post-verification counts at synth. Summing them reported
    // double the findings that exist.
    const out = summarizeReviewSeverity([
      stage("review-lens"),
      stage("review-verify", counts({ major: 3, nit: 2 })),
      stage("review-synth", counts({ major: 1 })),
    ]);
    expect(out).not.toBeNull();
    expect(out!.major).toBe(1); // the confirmed count, not 3 + 1
    expect(out!.nit).toBe(0);
  });

  it("prefers the post-verification synth record over verify candidates", () => {
    const out = summarizeReviewSeverity([
      stage("review-verify", counts({ blocker: 5 })),
      stage("review-synth", counts({ blocker: 1 })),
    ]);
    expect(out!.blocker).toBe(1);
  });

  it("falls back to candidates when synth never ran", () => {
    // Budget exhausted or no verdicts — candidates are the best available
    // view, and reporting nothing would be worse.
    const out = summarizeReviewSeverity([
      stage("review-verify", counts({ major: 2 })),
    ]);
    expect(out!.major).toBe(2);
  });

  it("reports REJECTED separately rather than in the headline", () => {
    const out = summarizeReviewSeverity([
      stage("review-synth", { ...counts({ major: 1 }), rejected: 4 }),
    ]);
    expect(out!.major).toBe(1);
    expect(out!.rejected).toBe(4);
  });

  it("is null when no stage recorded severity", () => {
    expect(summarizeReviewSeverity([stage("implementer")])).toBeNull();
  });

  it("still sums across a non-panel run's records", () => {
    // A single-reviewer run records severity once; nothing to reconcile.
    const out = summarizeReviewSeverity([
      stage("reviewer", counts({ minor: 2 })),
    ]);
    expect(out!.minor).toBe(2);
  });
});

describe("reconciliation is per-iteration, not global", () => {
  const iter = (
    n: number,
    name: string,
    sev: Partial<NonNullable<StageRecord["reviewSeverity"]>>
  ) => ({
    ...stage(name, counts(sev)),
    iteration: n,
  });

  it("still accumulates findings ACROSS iterations", () => {
    // Collapsing globally would report only the last iteration and lose the
    // run-wide total — the opposite error to double-counting.
    const out = summarizeReviewSeverity([
      iter(1, "review-verify", { major: 3 }),
      iter(1, "review-synth", { major: 2 }),
      iter(2, "review-verify", { major: 5 }),
      iter(2, "review-synth", { major: 1 }),
    ]);
    expect(out!.major).toBe(3); // 2 from iter 1 + 1 from iter 2, not 11
  });

  it("sums rejected counts across iterations too", () => {
    const out = summarizeReviewSeverity([
      {
        ...stage("review-synth", { ...counts({ major: 1 }), rejected: 2 }),
        iteration: 1,
      },
      {
        ...stage("review-synth", { ...counts({ major: 1 }), rejected: 3 }),
        iteration: 2,
      },
    ]);
    expect(out!.major).toBe(2);
    expect(out!.rejected).toBe(5);
  });
});
