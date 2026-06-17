import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";

// The apply-review follow-up trail is template-driven: no otto code writes
// .otto/review-followups.md — the apply-review.md template both (a) surfaces any
// existing trail into the prompt so prior deferrals carry across runs, and (b)
// instructs the agent to append deferred findings there and commit them WITH the
// fix. These tests pin that contract so the trail can't silently break.

const applyReviewTpl = fileURLToPath(
  new URL("../../templates/apply-review.md", import.meta.url)
);

function render(ws: string): string {
  return renderTemplate(
    applyReviewTpl,
    { INPUTS: "review.md", RESUME: "" },
    { cwd: ws }
  );
}

describe("apply-review follow-up trail", () => {
  it("surfaces an existing review-followups.md so prior deferrals carry into the next run", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-ar-"));
    try {
      mkdirSync(join(ws, ".otto"), { recursive: true });
      writeFileSync(
        join(ws, ".otto", "review-followups.md"),
        "## 2026-06-16 review\n- [perf] re-reads N days every pull — deferred, out of scope\n",
        "utf8"
      );
      const out = render(ws);
      // The recorded follow-up is inlined into the <existing-followups> block,
      // not collapsed to the fallback — the next run can see what was deferred.
      // Assert a fixture-unique substring: "re-reads N days every pull" also
      // appears verbatim in the template's own TRIAGE example, so it would pass
      // even if the fixture were never inlined.
      expect(out).toContain("deferred, out of scope");
      expect(out).not.toContain("_No follow-ups recorded yet._");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back gracefully when no follow-ups have been recorded yet", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-ar-"));
    try {
      const out = render(ws);
      expect(out).toContain("_No follow-ups recorded yet._");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("instructs recording deferred findings to .otto/review-followups.md and committing them with the fix", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-ar-"));
    try {
      const out = render(ws);
      // Deferred findings have a dedicated triage class...
      expect(out).toContain("Deferred / follow-up");
      // ...land in the git-tracked trail file...
      expect(out).toContain("./.otto/review-followups.md");
      // ...and are committed WITH the fix, never as a separate commit, so the
      // trail is reviewable alongside the change in git.
      expect(out).toContain("commit it WITH the related fix");
      expect(out).toContain("do not make a separate commit");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// The six contract sections, in order — must match quality-report.test.ts.
const CONTRACT_SECTIONS = [
  "## Verdict",
  "## Task Source",
  "## What Changed",
  "## Evidence",
  "## Human Acceptance Checklist",
  "## Gaps And Follow-Ups",
];

describe("apply-review adopts the quality report contract", () => {
  // apply-review is a standalone gate template (it does NOT @include
  // ghprompt-workflow.md), so for parity it pulls in the SAME shared
  // quality-report fragment directly — like verify.md — rather than
  // re-describing the report shape (the repo's drift-proofing convention).
  it("includes the shared fragment rather than re-describing the shape", () => {
    const body = readFileSync(applyReviewTpl, "utf8");
    expect(body).toContain("@include:quality-report.md");
  });

  it("surfaces the contract sections end-to-end when rendered", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-ar-"));
    try {
      const out = render(ws);
      for (const section of CONTRACT_SECTIONS) {
        expect(out).toContain(section);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("emits the report only at completion, summarizing the review-fix round", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-ar-"));
    try {
      const out = render(ws);
      // The report is the completion handoff: it lands with the NO MORE TASKS
      // sentinel, summarizing the whole round — not emitted per-iteration.
      expect(out).toContain("Otto quality report");
      expect(out).toContain("NO MORE TASKS");

      // Pin the gating prose itself — the report is final-iteration-only, never
      // per-iteration. Without these the guard could be deleted and the test
      // (which only checks the report+sentinel co-occur) would still pass.
      expect(out).toContain("Only on the final iteration");
      expect(out).toContain("Do NOT emit it per-iteration");

      // The fixed / deferred / won't-fix mapping must live in the COMPLETION
      // REPORT section. Scope the assertions to that section — "deferred" and
      // "fixed" also appear in the TRIAGE / RECONCILE prose, so an unscoped
      // match would pass even if the mapping were absent.
      const start = out.indexOf("# COMPLETION REPORT");
      expect(start).toBeGreaterThanOrEqual(0);
      const report = out.slice(start, out.indexOf("# FINAL RULES", start));
      expect(report).toContain("CONFIRMED and fixed");
      expect(report).toMatch(/DEFERRED/);
      expect(report).toMatch(/won't[- ]fix|wont[- ]fix/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
