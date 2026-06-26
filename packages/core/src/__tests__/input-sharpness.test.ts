import { describe, expect, it } from "vitest";

import {
  formatInputSharpness,
  scoreInputSharpness,
  INPUT_DIMENSIONS,
  type InputDimension,
} from "../input-sharpness.js";

// A deliberately sharp input that names every dimension.
const SHARP = [
  "## Problem",
  "Today users cannot reset their password because the flow has no email step.",
  "## Goal",
  "We want to let a user reset their password so that they regain access.",
  "## Constraints",
  "Must reuse the existing mailer; the token must expire within 30 minutes.",
  "## Success criteria",
  "Done when a user can request a reset link and set a new password; covered by a test.",
  "## Non-goals",
  "Out of scope: SSO and account recovery via SMS.",
].join("\n");

describe("scoreInputSharpness", () => {
  it("scores a sharp input as fully met with no unknowns", () => {
    const s = scoreInputSharpness(SHARP);
    expect(s.metCount).toBe(s.maxScore);
    expect(s.ratio).toBe(1);
    expect(s.unknowns).toEqual([]);
    expect(s.results.every((r) => r.met)).toBe(true);
  });

  it("scores a thin one-line input as low, listing the missing dimensions as unknowns", () => {
    const s = scoreInputSharpness("make the dashboard faster");
    expect(s.ratio).toBeLessThan(0.5);
    // The unknowns are exactly the unmet dimension labels — what a sharpening
    // pass must clarify (or record an assumption for in AFK).
    expect(s.unknowns.length).toBeGreaterThan(0);
    expect(s.unknowns).toEqual(
      s.results.filter((r) => !r.met).map((r) => r.label)
    );
  });

  it("detects each dimension independently", () => {
    const probes: Array<[InputDimension, string]> = [
      ["problem", "Currently the import fails because the parser is strict."],
      ["goal", "The objective is to let users export their data."],
      ["constraints", "It must run within the existing 512MB memory limit."],
      [
        "successCriteria",
        "Success criteria: the report renders in under 2s, verified by a test.",
      ],
      ["scope", "Non-goals: we will not touch the billing system."],
    ];
    for (const [dim, text] of probes) {
      const s = scoreInputSharpness(text);
      const hit = s.results.find((r) => r.dimension === dim);
      expect(hit?.met, `expected to detect ${dim} in: ${text}`).toBe(true);
    }
  });

  it("scores an empty input as fully unmet (ratio 0)", () => {
    const s = scoreInputSharpness("");
    expect(s.metCount).toBe(0);
    expect(s.ratio).toBe(0);
    expect(s.unknowns).toHaveLength(INPUT_DIMENSIONS.length);
  });
});

describe("formatInputSharpness", () => {
  it("renders a scorecard with the ratio and the unknowns to clarify", () => {
    const out = formatInputSharpness(scoreInputSharpness("make it faster"));
    expect(out).toMatch(/input sharpness/i);
    expect(out).toMatch(/\d+\/\d+/); // met/max
    // Lists at least one unknown the sharpening pass would clarify.
    expect(out.toLowerCase()).toContain("clarify");
  });

  it("reports a sharp input as needing no clarification", () => {
    const out = formatInputSharpness(scoreInputSharpness(SHARP));
    expect(out).toMatch(/input sharpness/i);
    expect(out).toMatch(/5\/5|no (?:gaps|unknowns)/i);
  });
});
