import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";

// The Otto quality report contract is the foundation of the issue-19 roadmap:
// one readable verification artifact reused across every run mode. It lives in a
// single includable fragment (templates/quality-report.md) so provider templates
// @include the SAME shape instead of re-describing it (the repo's drift-proofing
// convention, like ghprompt-workflow.md / linear-completion.md). No otto src code
// writes the report — the template instructs the agent — so the contract is
// pinned at the render-contract level, mirroring apply-review.test.ts.

const tpl = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

// The six contract sections, in order. Parity tasks reuse the same headings.
const CONTRACT_SECTIONS = [
  "## Verdict",
  "## Task Source",
  "## What Changed",
  "## Evidence",
  "## Human Acceptance Checklist",
  "## Gaps And Follow-Ups",
];

function renderFragment(): string {
  // Render the fragment standalone via an absolute @include so the real file is
  // read (matching the superpowers-include test pattern).
  const dir = mkdtempSync(join(tmpdir(), "otto-qr-"));
  try {
    const wrap = join(dir, "wrap.md");
    writeFileSync(wrap, `@include:${tpl("quality-report.md")}`, "utf8");
    return renderTemplate(wrap, { INPUTS: "" }, { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("quality report contract fragment", () => {
  it("declares all six contract sections", () => {
    const out = renderFragment();
    for (const section of CONTRACT_SECTIONS) {
      expect(out).toContain(section);
    }
  });

  it("offers the four-value verdict vocabulary", () => {
    const out = renderFragment();
    for (const verdict of [
      "Accepted",
      "Accepted with follow-ups",
      "Needs human review",
      "Rejected",
    ]) {
      expect(out).toContain(verdict);
    }
  });

  it("defaults the verdict to human review when evidence/scope is uncertain", () => {
    // Protects the issue's "model self-evaluation is not a replacement for human
    // review" boundary: Otto must not self-declare Accepted on thin evidence.
    const out = renderFragment().toLowerCase();
    expect(out).toContain("needs human review");
    expect(out).toMatch(/uncertain|unsure|thin/);
  });

  it("treats tests as evidence, not the verdict", () => {
    // Explicit issue goal: "Make tests part of the evidence section, not the
    // whole verdict."
    const out = renderFragment().toLowerCase();
    expect(out).toMatch(/evidence,? not the verdict|not the (whole )?verdict/);
  });
});

describe("verify.md adopts the quality report contract", () => {
  it("includes the shared fragment rather than re-describing the shape", () => {
    const body = readFileSync(tpl("verify.md"), "utf8");
    expect(body).toContain("@include:quality-report.md");
  });

  it("surfaces the contract sections when rendered, keeping read-only guardrails", () => {
    // Render into a throwaway non-git workspace: the !? shell tags (git log /
    // cat learnings) fall back, and the included contract resolves.
    const dir = mkdtempSync(join(tmpdir(), "otto-vr-"));
    try {
      const out = renderTemplate(
        tpl("verify.md"),
        { INPUTS: "plan.md and prd.md", RESUME: "" },
        { cwd: dir }
      );
      for (const section of CONTRACT_SECTIONS) {
        expect(out).toContain(section);
      }
      // The read-only / single-write guardrails must survive the rewrite.
      expect(out).toContain(".otto-tmp/verify-report.md");
      expect(out).toMatch(/NO commits|Do not commit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
