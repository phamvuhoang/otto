import { describe, expect, it } from "vitest";

import {
  assessFactSurvival,
  extractAnchors,
  formatFactSurvival,
} from "../compression-survival.js";
import { compressContentSync } from "../context-compressor.js";
import { libraryHeadroomRunner } from "../headroom-adapter.js";

describe("assessFactSurvival", () => {
  it("reports every fact surviving when all appear in the compressed text", () => {
    const facts = ["E4021", "v2.3.1", "src/loop.ts"];
    const compressed =
      "Summary: the E4021 error in src/loop.ts regressed in v2.3.1.";
    const s = assessFactSurvival(facts, compressed);
    expect(s.total).toBe(3);
    expect(s.survived).toBe(3);
    expect(s.survivalRate).toBe(1);
    expect(s.missing).toEqual([]);
  });

  it("names the missing facts, in input order, when some are dropped", () => {
    const facts = ["E4021", "v2.3.1", "src/loop.ts", "OTTO_HEADROOM_BIN"];
    const compressed = "The E4021 error touched src/loop.ts.";
    const s = assessFactSurvival(facts, compressed);
    expect(s.total).toBe(4);
    expect(s.survived).toBe(2);
    expect(s.missing).toEqual(["v2.3.1", "OTTO_HEADROOM_BIN"]);
    expect(s.survivalRate).toBeCloseTo(0.5, 5);
  });

  it("matches case-insensitively and tolerates collapsed whitespace", () => {
    const facts = ["acceptance criterion 3", "E4021"];
    const compressed = "meets Acceptance   Criterion 3; no e4021 anymore.";
    const s = assessFactSurvival(facts, compressed);
    expect(s.survived).toBe(2);
    expect(s.missing).toEqual([]);
  });

  it("treats an empty fact list as vacuously fully-surviving (no NaN)", () => {
    const s = assessFactSurvival([], "anything");
    expect(s.total).toBe(0);
    expect(s.survived).toBe(0);
    expect(s.survivalRate).toBe(1);
    expect(s.missing).toEqual([]);
  });
});

describe("extractAnchors", () => {
  it("extracts file paths, identifier codes, and versions in appearance order", () => {
    const text =
      "After upgrading to v2.3.1 the loop emits E4021 inside " +
      "packages/core/src/loop.ts when OTTO_HEADROOM_BIN is set.";
    expect(extractAnchors(text)).toEqual([
      "v2.3.1",
      "E4021",
      "packages/core/src/loop.ts",
      "OTTO_HEADROOM_BIN",
    ]);
  });

  it("dedups repeated anchors and caps the count", () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `E4021 fails in pkg/f${i}.ts`
    ).join("\n");
    const anchors = extractAnchors(text);
    expect(anchors.filter((a) => a === "E4021")).toEqual(["E4021"]);
    expect(anchors.length).toBeLessThanOrEqual(12);
  });

  it("ignores plain prose and bare acronyms without digits or underscores", () => {
    expect(
      extractAnchors("THE API and HTTP README are fine, said the reviewer.")
    ).toEqual([]);
  });
});

describe("formatFactSurvival", () => {
  it("renders a one-line summary with the ratio and rounded percentage", () => {
    const s = assessFactSurvival(
      ["E4021", "v2.3.1", "src/loop.ts"],
      "the E4021 error in src/loop.ts"
    );
    const line = formatFactSurvival(s);
    expect(line).toContain("2/3");
    expect(line).toContain("67%");
  });

  it("renders 100% when every fact survives", () => {
    const s = assessFactSurvival(["E4021"], "the E4021 error");
    expect(formatFactSurvival(s)).toContain("100%");
  });
});

// A realistic, multi-KB ghafk-style issue body (the `retrievable`/`issue-body`
// content the spill path compresses). The BURIED_FACTS are distinctive
// identifiers a summarizer should preserve; the surrounding prose is padded with
// repeated reproduction detail so the payload clears Headroom's ~250-token
// compression threshold.
const BURIED_FACTS = [
  "E4021", // an error code
  "v2.3.1", // the regressing release
  "src/context/loop.ts", // the implicated file
  "OTTO_HEADROOM_BIN", // the config/env key
  "acceptance criterion 3", // a numbered requirement
];
const ISSUE_BODY = [
  "## Bug: loop stalls after compression is enabled",
  "",
  "After upgrading to v2.3.1 the run loop intermittently stalls and emits",
  "error E4021 during the render boundary. The stall originates in",
  "src/context/loop.ts when the compressor is resolved from OTTO_HEADROOM_BIN.",
  "",
  "### Reproduction",
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `${i + 1}. Start a long unattended run with a large pasted issue body and ` +
      `watch the render boundary spill the issue text; the stall reproduces ` +
      `reliably once the window fills with prior-iteration evidence.`
  ),
  "",
  "### Acceptance criteria",
  "1. The loop no longer stalls when compression is enabled.",
  "2. The stall error is no longer emitted at the render boundary.",
  "3. acceptance criterion 3: buried facts (codes, versions, paths, config",
  "   keys) remain retrievable after the issue body is compressed.",
].join("\n");
// Each buried fact appears exactly ONCE in the body (issue #202) — a summarizer
// can't earn survival credit from a redundant second mention.
for (const fact of BURIED_FACTS) {
  const count = ISSUE_BODY.split(fact).length - 1;
  if (count !== 1) {
    throw new Error(`fixture drift: "${fact}" appears ${count}× (expected 1)`);
  }
}

// The fixture driven through the REAL runtime keep-decision (issue #202): the
// same compressContentSync path the render boundary calls, with deterministic
// summarizers standing in for Headroom. This is the CI-runnable half of the
// fact-survival proof — the model-backed half below stays opt-in.
describe("survival fixture through the runtime compress path", () => {
  const runtime = (
    summarize: (t: string) => string
  ): Parameters<typeof compressContentSync>[0] => ({
    name: "headroom",
    version: "eval-1",
    available: true,
    compress: (i) => ({ ok: true, text: summarize(i.text) }),
  });
  const input = { key: "s", category: "issue-body" as const, text: ISSUE_BODY };

  it("a fact-dropping summarization is rejected by the floor — the run keeps the original", () => {
    const out = compressContentSync(
      runtime(() => "The loop stalls after compression is enabled (summary)."),
      input,
      null
    );
    expect(out.degraded).toBe(true);
    expect(out.text).toBe(ISSUE_BODY);
    // End to end, every buried fact is still in the text the run uses.
    expect(assessFactSurvival(BURIED_FACTS, out.text).survivalRate).toBe(1);
  });

  it("a fact-preserving summarization is kept, with every buried fact surviving", () => {
    const summary =
      "E4021 regressed in v2.3.1 in src/context/loop.ts when OTTO_HEADROOM_BIN " +
      "is set; fix per acceptance criterion 3.";
    const out = compressContentSync(
      runtime(() => summary),
      input,
      null
    );
    expect(out.degraded).toBe(false);
    expect(out.text).toBe(summary);
    expect(out.tokensSaved).toBeGreaterThan(0);
    expect(assessFactSurvival(BURIED_FACTS, out.text).survivalRate).toBe(1);
  });
});

// Real Headroom, no fake spawn — proves distinctive buried facts SURVIVE library-mode
// compression (not merely that the payload shrinks, which headroom-adapter's e2e
// already covers). Gated behind OTTO_HEADROOM_E2E=1 so the normal suite never
// triggers the ~600 MB model download. Run it with:
//   OTTO_HEADROOM_E2E=1 pnpm --filter @phamvuhoang/otto-core test -- compression-survival
// FLOOR is the survival rate the eval enforces before compression is trusted for
// this content; a run below it is a real signal to investigate, not CI flake.
describe("buried-fact survival under real Headroom compression", () => {
  const FLOOR = 0.8;
  const optedIn = process.env.OTTO_HEADROOM_E2E === "1";
  const realRunner = libraryHeadroomRunner(
    { ...process.env, HF_HUB_OFFLINE: "0" },
    600_000
  );
  const maybe = optedIn && realRunner.available() ? it : it.skip;

  maybe(
    "compresses a bulky issue body while keeping its buried facts retrievable",
    () => {
      const out = realRunner.run({
        key: "survival",
        category: "issue-body",
        text: ISSUE_BODY,
      });
      expect(out.ok).toBe(true);
      expect(out.text.length).toBeLessThan(ISSUE_BODY.length); // actually compressed
      const survival = assessFactSurvival(BURIED_FACTS, out.text);
      expect(
        survival.survivalRate,
        `missing after compression: ${survival.missing.join(", ") || "none"}`
      ).toBeGreaterThanOrEqual(FLOOR);
    },
    600_000
  );
});
