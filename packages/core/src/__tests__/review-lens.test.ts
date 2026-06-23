import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";

// The review panel is lens-parametric: any lens name in OTTO_REVIEW_LENSES is
// rendered into review-lens.md via {{ LENS }}, but the template carries the
// per-lens *definition* the reviewer reasons from. Feature 2 (issue #19) adds a
// `task-fit` lens — "did Otto solve the right problem / is it reviewer-useful" —
// alongside correctness/security/tests. These tests pin that the definition
// ships, that it augments (not replaces) the baseline three, and that the
// generic lens wiring still surfaces whichever lens is selected.

const reviewLensTpl = fileURLToPath(
  new URL("../../templates/review-lens.md", import.meta.url)
);

function render(lens: string): string {
  const ws = mkdtempSync(join(tmpdir(), "otto-lens-"));
  try {
    return renderTemplate(
      reviewLensTpl,
      { LENS: lens },
      {
        cwd: ws,
        spillHostDir: join(ws, "spill"),
        spillRefPath: "spill",
      }
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

describe("structural lens (P14)", () => {
  it("injects the seven structural standards for LENS=structural", () => {
    const out = render("structural");
    expect(out).toContain("# REVIEWER — structural lens");
    expect(out).toMatch(/code judo|structural simplification/i);
    expect(out).toMatch(/1,?000 lines/);
    expect(out).toMatch(/spaghetti|ad-hoc conditional/i);
  });

  it("instructs every lens to emit the severity wire format", () => {
    const out = render("correctness");
    expect(out).toMatch(/SEVERITY \| file:line \| claim \| why \| fix/);
    expect(out).toMatch(/blocker.*major.*minor.*nit/i);
  });

  it("renders existing lenses without structural guidance leaking in", () => {
    const out = render("tests");
    expect(out).not.toMatch(/code judo/i);
  });
});

describe("review-lens task-fit lens", () => {
  it("ships a task-fit lens definition focused on solving the right problem", () => {
    const out = render("task-fit");
    expect(out).toMatch(/`task-fit`/);
    // The definition must capture task fulfillment / reviewer usefulness, the
    // distinguishing concern separate from correctness/security/tests.
    expect(out).toMatch(/right problem|task fulfillment|reviewer-useful/i);
  });

  it("augments rather than replaces the baseline three lenses", () => {
    const out = render("correctness");
    for (const lens of ["correctness", "security", "tests", "task-fit"]) {
      expect(out).toMatch(new RegExp("`" + lens + "`"));
    }
  });

  it("renders the selected lens into the reviewer header (generic wiring)", () => {
    expect(render("task-fit")).toContain("# REVIEWER — task-fit lens");
  });
});
