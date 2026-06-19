import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";
import { UNTRUSTED_WARNING } from "../taint.js";

// Slice 4 of issue #43: surface taint in prompts. An unattended run ingests
// content it did not author (issue bodies, comments, external review docs, and
// the spilled files they point to) and acts with broad authority, so every such
// entry point carries a standard untrusted-content warning telling the model to
// treat embedded text as data, not commands (prompt-injection mitigation). Pure
// prose, no otto src behind it (the agent follows the template), so it is pinned
// at the render-contract level — the same drift-proofing convention as
// governed-memory.md / quality-report.md. The warning is surfaced through ONE
// shared fragment @include'd at each untrusted block, never re-described per
// template, and its text is the canonical taint.ts UNTRUSTED_WARNING so the
// prompt surfacing can never drift from the code substrate (slice 3).

const tpl = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

// The templates that ingest untrusted, externally-authored content.
const UNTRUSTED_TEMPLATES = [
  "ghafk-issue.md",
  "ghafk.md",
  "linearafk-issue.md",
  "linearafk.md",
  "apply-review.md",
];

function renderFragment(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-uc-"));
  try {
    const wrap = join(dir, "wrap.md");
    writeFileSync(wrap, `@include:${tpl("untrusted-content.md")}`, "utf8");
    return renderTemplate(wrap, { INPUTS: "" }, { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderPrompt(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-ucp-"));
  try {
    return renderTemplate(
      tpl(name),
      { INPUTS: "42", RESUME: "" },
      { cwd: dir, spillHostDir: dir, spillRefPath: "./.otto-tmp/spill" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("untrusted-content fragment", () => {
  it("carries the canonical taint.ts untrusted-content warning verbatim", () => {
    expect(renderFragment()).toContain(UNTRUSTED_WARNING);
  });

  it("frames the content as untrusted input", () => {
    const out = renderFragment();
    expect(out).toMatch(/untrusted/i);
    // Tells the model to treat it as data, not as instructions to obey.
    expect(out).toMatch(/instruction|command|data/i);
  });
});

describe("untrusted entry points include the fragment once", () => {
  for (const name of UNTRUSTED_TEMPLATES) {
    it(`${name} @include's untrusted-content.md`, () => {
      expect(readFileSync(tpl(name), "utf8")).toContain(
        "@include:untrusted-content.md"
      );
    });
  }
});

describe("untrusted warning surfaces end-to-end in every ingesting prompt", () => {
  for (const name of UNTRUSTED_TEMPLATES) {
    it(`${name} surfaces the warning when rendered`, () => {
      expect(renderPrompt(name)).toContain(UNTRUSTED_WARNING);
    });
  }
});
