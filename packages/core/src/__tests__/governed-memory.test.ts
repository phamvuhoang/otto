import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";

// Slice 6b of issue #42: the compaction-tier model + how a run writes a governed
// memory record. Pure prose, no otto src code behind it (the agent follows the
// template), so it is pinned at the render-contract level — the same drift-proofing
// convention as quality-report.md / acceptance-prompts.md. The fragment is
// @include'd by BOTH playbook LEARNINGS sections (prompt.md for afk;
// ghprompt-workflow.md for every *afk* provider mode), so the model reaches every
// mode through ONE fragment rather than being re-described per template.

const tpl = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

// The four compaction tiers the issue names, smallest-living-longest.
const TIERS = [
  "Active context",
  "Summarized state",
  "Reconstructable artifacts",
  "Durable memory",
];

function renderFragment(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-gm-"));
  try {
    const wrap = join(dir, "wrap.md");
    writeFileSync(wrap, `@include:${tpl("governed-memory.md")}`, "utf8");
    return renderTemplate(wrap, { INPUTS: "" }, { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("governed-memory fragment", () => {
  it("documents the four compaction tiers", () => {
    const out = renderFragment();
    for (const tier of TIERS) {
      expect(out).toContain(tier);
    }
  });

  it("locates each tier on its real artifact", () => {
    const out = renderFragment();
    // Durable memory = governed records; LEARNINGS.md = the projection;
    // reconstructable evidence = logs / run bundles.
    expect(out).toContain("./.otto/memory/");
    expect(out).toContain("./.otto/LEARNINGS.md");
    expect(out).toMatch(/\.otto-tmp\/logs|\.otto\/runs/);
  });

  it("defines how a run writes a governed record (fields + provenance/freshness/scope)", () => {
    const out = renderFragment();
    // The governance fields a fresh run-produced record must carry.
    for (const field of [
      "category",
      "taskKey",
      "scope",
      "confidence",
      "trust",
      "status",
    ]) {
      expect(out).toContain(field);
    }
    // run-produced learnings are unverified until a human promotes them; freshness
    // is optional and time-bounded.
    expect(out).toContain("unverified");
    expect(out).toMatch(/expiresAt|revalidateAfterDays/);
    // Contradiction handling: supersede an older record rather than diverge.
    expect(out).toMatch(/supersede/i);
  });

  it("points at the otto-memory inspection/projection commands", () => {
    const out = renderFragment();
    expect(out).toContain("otto-memory audit");
    expect(out).toContain("otto-memory project");
  });
});

describe("playbooks include the governed-memory fragment once", () => {
  // afk path: afk.md -> prompt.md ; *afk* provider paths: ghafk/linear ->
  // ghprompt-workflow.md. The two LEARNINGS sections are disjoint per rendered
  // prompt, so one @include each gives every mode the model exactly once.
  for (const playbook of ["prompt.md", "ghprompt-workflow.md"]) {
    it(`${playbook} includes governed-memory.md in its LEARNINGS section`, () => {
      const body = readFileSync(tpl(playbook), "utf8");
      expect(body).toContain("@include:governed-memory.md");
    });
  }

  it("surfaces the tiers + record prose end-to-end when an afk prompt renders", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-gma-"));
    try {
      const out = renderTemplate(
        tpl("afk.md"),
        { INPUTS: "plan", RESUME: "" },
        { cwd: dir }
      );
      for (const tier of TIERS) {
        expect(out).toContain(tier);
      }
      expect(out).toContain("./.otto/memory/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces the tiers + record prose end-to-end when a ghafk prompt renders", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-gmg-"));
    try {
      const out = renderTemplate(
        tpl("ghafk-issue.md"),
        { INPUTS: "42", RESUME: "" },
        { cwd: dir, spillHostDir: dir, spillRefPath: "./.otto-tmp/spill" }
      );
      for (const tier of TIERS) {
        expect(out).toContain(tier);
      }
      expect(out).toContain("./.otto/memory/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
