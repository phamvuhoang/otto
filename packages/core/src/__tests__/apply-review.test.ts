import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
