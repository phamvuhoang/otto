import { describe, expect, it } from "vitest";

import {
  REPORT_CRITERIA,
  formatReportRubric,
  scoreReportLegibility,
  type ReportCriterion,
} from "../report-rubric.js";

/**
 * A complete P9 quality-report document exercising every rubric criterion.
 * Shape mirrors the quality-report.md contract: layperson sections first,
 * engineer detail below the divider.
 */
const COMPLETE_REPORT = [
  "# Otto quality report",
  "",
  "## Verdict",
  "",
  "**Accepted**",
  "",
  "## What You Can Now Do",
  "",
  "The export feature now works for all users.",
  "",
  "## Why",
  "",
  "Users needed a way to download their data for offline analysis.",
  "",
  "## How To Verify",
  "",
  "1. Open the app and navigate to Settings.",
  "2. Click Export and check the downloaded file.",
  "",
  "## What To Watch",
  "",
  "Large exports may take a few seconds on slow connections.",
  "",
  "## What I Was Unsure About",
  "",
  "Nothing — this was straightforward.",
  "",
  "---",
  "",
  "_Engineer detail below — a non-engineer can stop reading here._",
  "",
  "## Task Source",
  "",
  "- Mode: ghafk",
  "",
  "## What Changed",
  "",
  "The export path is wired and tested.",
  "",
].join("\n");

/**
 * A thin, engineer-first doc with none of the required layperson sections.
 * Simulates a naive "just write what happened" report that fails the rubric.
 */
const THIN_REPORT =
  "# Summary\n\nAdded export.ts, wired it to the CLI, tests pass.\n";

describe("scoreReportLegibility", () => {
  it("scores a complete P9 report as fully met", () => {
    const score = scoreReportLegibility(COMPLETE_REPORT);
    expect(score.maxScore).toBe(REPORT_CRITERIA.length);
    expect(score.metCount).toBe(REPORT_CRITERIA.length);
    expect(score.ratio).toBe(1);
    expect(score.missing).toEqual([]);
    expect(score.results.every((r) => r.met)).toBe(true);
  });

  it("scores a thin / engineer-first report as mostly unmet", () => {
    const score = scoreReportLegibility(THIN_REPORT);
    expect(score.metCount).toBe(0);
    expect(score.ratio).toBe(0);
    expect(score.missing).toHaveLength(REPORT_CRITERIA.length);
    expect(score.results.every((r) => !r.met)).toBe(true);
  });

  it("detects each criterion independently (neither always-true nor always-false)", () => {
    const complete = scoreReportLegibility(COMPLETE_REPORT);
    const thin = scoreReportLegibility(THIN_REPORT);
    for (const c of REPORT_CRITERIA) {
      const id = c.criterion as ReportCriterion;
      expect(
        complete.results.find((r) => r.criterion === id)?.met,
        `${id} should be met in complete report`
      ).toBe(true);
      expect(
        thin.results.find((r) => r.criterion === id)?.met,
        `${id} should be unmet in thin report`
      ).toBe(false);
    }
  });

  it("reports a partial score with the missing criteria named", () => {
    const partial = [
      "## Verdict",
      "",
      "**Accepted**",
      "",
      "## What You Can Now Do",
      "",
      "Something changed.",
    ].join("\n");
    const score = scoreReportLegibility(partial);
    expect(score.metCount).toBe(2);
    expect(score.ratio).toBeCloseTo(2 / REPORT_CRITERIA.length);
    expect(score.missing.length).toBe(REPORT_CRITERIA.length - 2);
    expect(score.results.find((r) => r.criterion === "verdict")?.met).toBe(
      true
    );
    expect(
      score.results.find((r) => r.criterion === "whatYouCanNowDo")?.met
    ).toBe(true);
    expect(score.results.find((r) => r.criterion === "howToVerify")?.met).toBe(
      false
    );
  });

  it("handles an empty / whitespace doc without throwing", () => {
    for (const doc of ["", "   \n\t  \n"]) {
      const score = scoreReportLegibility(doc);
      expect(score.metCount).toBe(0);
      expect(score.ratio).toBe(0);
      expect(score.results).toHaveLength(REPORT_CRITERIA.length);
    }
  });

  it("requires both the How To Verify heading AND a numbered step", () => {
    // heading only — no numbered step
    const headingOnly = "## How To Verify\n\nCheck the thing.";
    expect(
      scoreReportLegibility(headingOnly).results.find(
        (r) => r.criterion === "howToVerify"
      )?.met
    ).toBe(false);

    // numbered step only — no heading
    const stepOnly = "1. Click the button and check the result.";
    expect(
      scoreReportLegibility(stepOnly).results.find(
        (r) => r.criterion === "howToVerify"
      )?.met
    ).toBe(false);

    // both present
    const both = "## How To Verify\n\n1. Click the button.";
    expect(
      scoreReportLegibility(both).results.find(
        (r) => r.criterion === "howToVerify"
      )?.met
    ).toBe(true);
  });

  it("requires the Engineer detail divider for engineerDivider", () => {
    const withDivider =
      "Some prose.\n\n_Engineer detail below — a non-engineer can stop reading here._\n\n## Evidence";
    expect(
      scoreReportLegibility(withDivider).results.find(
        (r) => r.criterion === "engineerDivider"
      )?.met
    ).toBe(true);

    const withoutDivider = "Some prose.\n\n## Evidence\n\nstuff";
    expect(
      scoreReportLegibility(withoutDivider).results.find(
        (r) => r.criterion === "engineerDivider"
      )?.met
    ).toBe(false);
  });
});

describe("formatReportRubric", () => {
  it("renders a scorecard with the score and a per-criterion marker", () => {
    const out = formatReportRubric(scoreReportLegibility(COMPLETE_REPORT));
    expect(out).toMatch(/report legibility/i);
    expect(out).toContain(
      `${REPORT_CRITERIA.length}/${REPORT_CRITERIA.length}`
    );
    expect(out).toContain("100%");
    for (const c of REPORT_CRITERIA) expect(out).toContain(c.label);
  });

  it("names the missing criteria when the report is incomplete", () => {
    const out = formatReportRubric(scoreReportLegibility(THIN_REPORT));
    expect(out).toMatch(/0\/\d+|0%/);
    expect(out).toMatch(/missing/i);
  });

  it("renders a checked marker for met criteria and unchecked for unmet", () => {
    const out = formatReportRubric(scoreReportLegibility(COMPLETE_REPORT));
    expect(out).toContain("[x]");
    expect(out).not.toContain("[ ]");

    const thinOut = formatReportRubric(scoreReportLegibility(THIN_REPORT));
    expect(thinOut).toContain("[ ]");
    expect(thinOut).not.toContain("[x]");
  });
});
