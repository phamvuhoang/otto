import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";

const TEMPLATES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates"
);
const FALLBACK = "No learnings recorded yet";

function makeWorkspace(learnings?: string): string {
  const ws = mkdtempSync(join(tmpdir(), "otto-learn-"));
  if (learnings !== undefined) {
    mkdirSync(join(ws, ".otto"), { recursive: true });
    writeFileSync(join(ws, ".otto", "LEARNINGS.md"), learnings, "utf8");
  }
  return ws;
}

describe("learnings read-back block", () => {
  it("injects .otto/LEARNINGS.md into the implementer (afk) prompt", () => {
    const ws = makeWorkspace("## Gotchas\n- pnpm not npm\n");
    try {
      const out = renderTemplate(
        join(TEMPLATES, "afk.md"),
        { INPUTS: "plan" },
        { cwd: ws }
      );
      expect(out).toContain("- pnpm not npm");
      expect(out).not.toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back when .otto/LEARNINGS.md is absent (afk)", () => {
    const ws = makeWorkspace();
    try {
      const out = renderTemplate(
        join(TEMPLATES, "afk.md"),
        { INPUTS: "plan" },
        { cwd: ws }
      );
      expect(out).toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("injects learnings into the reviewer (review-synth) prompt", () => {
    const ws = makeWorkspace("## Decisions\n- chose X over Y\n");
    try {
      const out = renderTemplate(
        join(TEMPLATES, "review-synth.md"),
        {},
        { cwd: ws }
      );
      expect(out).toContain("- chose X over Y");
      expect(out).not.toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
