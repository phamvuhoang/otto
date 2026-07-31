import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";
import { prepareLearnings } from "../stage-exec.js";

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

/** What `executeStage` does: resolve the block, then render with it supplied. */
function renderWithHarnessLearnings(
  template: string,
  ws: string,
  vars: Record<string, string> = {}
): string {
  const LEARNINGS = prepareLearnings({ workspaceDir: ws, env: {} }).text;
  return renderTemplate(
    join(TEMPLATES, template),
    { ...vars, LEARNINGS },
    { cwd: ws }
  );
}

describe("learnings read-back block (harness-rendered, P29)", () => {
  it("injects .otto/LEARNINGS.md into the implementer (afk) prompt", () => {
    const ws = makeWorkspace("## Gotchas\n- pnpm not npm\n");
    try {
      const out = renderWithHarnessLearnings("afk.md", ws, { INPUTS: "plan" });
      expect(out).toContain("- pnpm not npm");
      expect(out).not.toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back when .otto/LEARNINGS.md is absent (afk)", () => {
    const ws = makeWorkspace();
    try {
      const out = renderWithHarnessLearnings("afk.md", ws, { INPUTS: "plan" });
      expect(out).toContain(FALLBACK);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("byte parity: the swapped block matches what the old cat tag produced", () => {
    // The whole safety argument for P29 Task 3 — a small LEARNINGS.md renders
    // char-for-char what `!?`cat …`` used to emit, so repos under the budget
    // see no change at all.
    const body = "## Gotchas\n- pnpm not npm\n- ESM only";
    const ws = makeWorkspace(`${body}\n`);
    try {
      const out = renderWithHarnessLearnings("afk.md", ws, { INPUTS: "plan" });
      expect(out).toContain(`<learnings>\n\n${body}\n\n</learnings>`);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("leaves the tag untouched when the harness does not supply it", () => {
    // renderTemplate leaves unknown {{ TAG }} literal (render.ts:213-215), so a
    // template rendered outside executeStage is inert rather than silently
    // emitting an empty learnings block.
    const ws = makeWorkspace("## Gotchas\n- pnpm not npm\n");
    try {
      const out = renderTemplate(
        join(TEMPLATES, "afk.md"),
        { INPUTS: "plan" },
        { cwd: ws }
      );
      expect(out).toContain("{{ LEARNINGS }}");
      expect(out).not.toContain("- pnpm not npm");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("still injects via the cat tag in a template this slice did not swap", () => {
    // review-synth.md is one of the seven deliberately left on the shell tag.
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
