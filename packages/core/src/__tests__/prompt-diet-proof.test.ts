import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";
import { prepareLearnings } from "../stage-exec.js";
import { writeMemoryRecord, type MemoryRecord } from "../memory.js";
import { estimateTokens } from "../context-report.js";

const TEMPLATES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates"
);

/** The pre-P29 injection: the whole LEARNINGS.md, as `!?`cat …`` produced. */
const RAW_LEARNINGS =
  "## Conventions\n" +
  "- a durable repo convention worth remembering\n".repeat(300);

/** A mature repo: a large LEARNINGS.md plus a governed record set. */
function matureRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), "otto-diet-"));
  mkdirSync(join(ws, ".otto"), { recursive: true });
  writeFileSync(join(ws, ".otto", "LEARNINGS.md"), RAW_LEARNINGS, "utf8");
  for (let i = 0; i < 12; i++) {
    const rec: MemoryRecord = {
      id: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00-00-00-00${i}Z-m`,
      content: `governed learning ${i}: a durable convention`,
      category: "convention",
      scope: [],
      confidence: 0.9,
      trust: "trusted",
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z",
      useCount: 1,
    };
    writeMemoryRecord(ws, rec);
  }
  return ws;
}

function render(template: string, ws: string, LEARNINGS: string): string {
  const spill = join(ws, ".otto-tmp", "s");
  mkdirSync(spill, { recursive: true });
  return renderTemplate(
    join(TEMPLATES, template),
    { INPUTS: "build the thing", RESUME: "", LENS: "correctness", LEARNINGS },
    { cwd: ws, spillHostDir: spill, spillRefPath: ".otto-tmp/s" }
  );
}

describe("P29 prompt diet delivers its target", () => {
  it("cuts implementer prompt tokens by >=20% on a mature repo", () => {
    const ws = matureRepo();
    try {
      const before = render("afk.md", ws, RAW_LEARNINGS.replace(/\n+$/, ""));
      const after = render(
        "afk.md",
        ws,
        prepareLearnings({ workspaceDir: ws, env: {} }).text
      );
      const saved =
        1 - estimateTokens(after.length) / estimateTokens(before.length);
      expect(
        saved,
        `saved ${(saved * 100).toFixed(1)}% (${before.length} -> ${after.length} chars)`
      ).toBeGreaterThanOrEqual(0.2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("multiplies across panel lenses, which render once per lens", () => {
    // review-lens.md is rendered N times per iteration, so the per-prompt
    // saving is paid N times over. This is why it was in the first slice.
    const ws = matureRepo();
    try {
      const LENSES = 4;
      const before =
        render("review-lens.md", ws, RAW_LEARNINGS.replace(/\n+$/, "")).length *
        LENSES;
      const after =
        render(
          "review-lens.md",
          ws,
          prepareLearnings({ workspaceDir: ws, env: {} }).text
        ).length * LENSES;
      expect(before - after).toBeGreaterThan(30_000);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("changes nothing for a repo whose LEARNINGS.md is under budget", () => {
    // The safety property: small repos must be byte-identical, or this is a
    // behavior change dressed up as an optimization.
    const ws = mkdtempSync(join(tmpdir(), "otto-diet-small-"));
    try {
      const small = "## Gotchas\n- pnpm not npm";
      mkdirSync(join(ws, ".otto"), { recursive: true });
      writeFileSync(join(ws, ".otto", "LEARNINGS.md"), `${small}\n`, "utf8");
      const before = render("afk.md", ws, small);
      const after = render(
        "afk.md",
        ws,
        prepareLearnings({ workspaceDir: ws, env: {} }).text
      );
      expect(after).toBe(before);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
