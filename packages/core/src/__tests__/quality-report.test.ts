import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
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
  "## What You Can Now Do",
  "## What Changed",
  "## Evidence",
  "## Human Acceptance Checklist",
  "## Gaps And Follow-Ups",
];

// P9 (#64): the report is layperson-first. These prose sections lead the body so
// a non-engineer can verify the run; the engineer-detail sections (Task Source,
// Evidence, …) sit below a visible divider.
const LAYPERSON_SECTIONS = [
  "## What You Can Now Do",
  "## Why",
  "## How To Verify",
  "## What To Watch",
  "## What I Was Unsure About",
];
const ENGINEER_DIVIDER = "Engineer detail below";

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

  it("leads with layperson prose sections before the engineer-detail divider (P9 #64)", () => {
    const out = renderFragment();
    for (const section of LAYPERSON_SECTIONS) {
      expect(out).toContain(section);
    }
    // A non-engineer can stop reading at the divider; engineer detail follows it.
    const dividerAt = out.indexOf(ENGINEER_DIVIDER);
    expect(dividerAt).toBeGreaterThan(-1);
    for (const section of LAYPERSON_SECTIONS) {
      expect(out.indexOf(section)).toBeLessThan(dividerAt);
    }
    for (const section of ["## Task Source", "## Evidence"]) {
      expect(out.indexOf(section)).toBeGreaterThan(dividerAt);
    }
    // Verdict stays first of all; the layperson summary follows it.
    expect(out.indexOf("## Verdict")).toBeLessThan(
      out.indexOf("## What You Can Now Do")
    );
    expect(out.indexOf("## What Changed")).toBeGreaterThan(dividerAt);
  });

  it("asks for plain-language verification steps and uncertainty (P9 #64)", () => {
    const out = renderFragment().toLowerCase();
    // How-to-verify is for a non-engineer: steps, not just a command dump.
    expect(out).toMatch(/non-technical|plain language|layperson|non-engineer/);
    // Uncertainty is surfaced in human terms, not left implicit.
    expect(out).toContain("## what i was unsure about");
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

describe("ghafk completion adopts the quality report contract", () => {
  // The FINISHING handoff lives in the provider-agnostic ghprompt-workflow.md
  // (shared by every *afk* mode), so emitting the report there gives GitHub the
  // parity summary AND reaches every other mode through the same single include
  // — the repo's drift-proofing convention. Linear then only overrides WHERE the
  // report lands (otto-linear comment), not the shape.
  it("includes the shared fragment in the workflow rather than re-describing it", () => {
    const body = readFileSync(tpl("ghprompt-workflow.md"), "utf8");
    expect(body).toContain("@include:quality-report.md");
  });

  it("instructs emitting the report into the PR/issue completion surface", () => {
    const body = readFileSync(tpl("ghprompt-workflow.md"), "utf8");
    expect(body).toContain("Otto quality report");
    // GitHub-specific completion surfaces: the PR body and the issue comment,
    // with concrete links/SHAs cited (parity goal: same human-readable signal).
    expect(body).toContain("PR description");
    expect(body).toContain("issue comment");
    expect(body).toMatch(/PR URL/);
  });

  it("surfaces the contract sections end-to-end when a ghafk template renders", () => {
    // Render the single-issue template through the include chain
    // (ghafk-issue.md -> ghprompt-workflow.md -> quality-report.md) in a
    // throwaway non-git workspace: the !? / @spill shell tags fall back and the
    // included contract resolves.
    const dir = mkdtempSync(join(tmpdir(), "otto-gq-"));
    try {
      const out = renderTemplate(
        tpl("ghafk-issue.md"),
        { INPUTS: "19" },
        { cwd: dir, spillHostDir: dir, spillRefPath: "./.otto-tmp/spill" }
      );
      for (const section of CONTRACT_SECTIONS) {
        expect(out).toContain(section);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("afk (plan/PRD) completion adopts the quality report contract", () => {
  // The FINISHING handoff lives in prompt.md (the afk implementer playbook
  // included by afk.md). The include must be in the "FINISHING THE RUN" section
  // so the report is emitted at completion, not per-iteration — the same finishing
  // point as the <promise>NO MORE TASKS</promise> sentinel.
  it("includes the shared fragment in prompt.md rather than re-describing it", () => {
    const body = readFileSync(tpl("prompt.md"), "utf8");
    expect(body).toContain("@include:quality-report.md");
  });

  it("places the include in the FINISHING THE RUN section (completion, not per-iteration)", () => {
    const body = readFileSync(tpl("prompt.md"), "utf8");
    const finishingIdx = body.indexOf("# FINISHING THE RUN");
    const includeIdx = body.indexOf("@include:quality-report.md");
    expect(finishingIdx).toBeGreaterThan(-1);
    expect(includeIdx).toBeGreaterThan(finishingIdx);
  });

  it("surfaces the contract sections end-to-end when the afk template renders", () => {
    // Render the afk template through its include chain
    // (afk.md -> prompt.md -> quality-report.md) in a throwaway non-git
    // workspace: the !? / @spill shell tags fall back and the included
    // contract resolves.
    const dir = mkdtempSync(join(tmpdir(), "otto-aq-"));
    try {
      const out = renderTemplate(
        tpl("afk.md"),
        { INPUTS: "plan prd", RESUME: "" },
        { cwd: dir, spillHostDir: dir, spillRefPath: "./.otto-tmp/spill" }
      );
      for (const section of CONTRACT_SECTIONS) {
        expect(out).toContain(section);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("per-mode human acceptance prompts", () => {
  // Feature 2: the generic Human Acceptance Checklist is mode-agnostic, but a
  // maintainer reviewing a plan/PRD run needs different acceptance questions than
  // one reviewing a review-repair round. The per-mode prompts live in ONE sibling
  // fragment (acceptance-prompts.md) included ONCE by quality-report.md, so every
  // mode inherits the same set through the existing contract include — the same
  // drift-proofing convention as the contract itself.
  const MODES = ["afk", "ghafk", "linear-afk", "apply-review", "verify"];

  function renderPrompts(): string {
    const dir = mkdtempSync(join(tmpdir(), "otto-ap-"));
    try {
      const wrap = join(dir, "wrap.md");
      writeFileSync(wrap, `@include:${tpl("acceptance-prompts.md")}`, "utf8");
      return renderTemplate(wrap, { INPUTS: "" }, { cwd: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("the contract fragment includes the per-mode prompts rather than inlining them", () => {
    const body = readFileSync(tpl("quality-report.md"), "utf8");
    expect(body).toContain("@include:acceptance-prompts.md");
  });

  it("offers an acceptance prompt set for every run mode", () => {
    const out = renderPrompts();
    for (const mode of MODES) {
      // Anchor on the heading, not the bare mode name: "afk" is a substring of
      // "ghafk"/"linear-afk", so toContain(mode) would pass even if the afk
      // block were deleted. The "### <mode> —" heading is unique per mode.
      expect(out).toContain(`### ${mode} —`);
    }
    // Mode-specific, not just the generic checklist: each set must pose
    // task-fulfillment questions a human can challenge.
    expect(out).toMatch(/acceptance criterion|stated problem|actually asked/i);
  });

  it("surfaces the per-mode prompts end-to-end when the contract renders", () => {
    // Render quality-report.md through its own include chain in a throwaway
    // workspace: the per-mode prompts must resolve via the single contract
    // include, proving every adopting mode inherits them.
    const out = renderFragment();
    for (const mode of MODES) {
      // Heading-anchored for the same reason as above: "afk" ⊂ "ghafk"/
      // "linear-afk", so a bare substring check would not actually pin the
      // afk block.
      expect(out).toContain(`### ${mode} —`);
    }
  });
});

describe("human-verdict trail", () => {
  // Feature 3: a lightweight, git-tracked trail of HUMAN verdicts on past Otto
  // runs (accepted / accepted-with-follow-ups / rejected / needs-investigation +
  // why). It lives in the ONE shared quality-report fragment — like the report
  // shape itself — so every mode both (a) surfaces the existing trail (prior
  // verdicts inform this run's verdict + next action) and (b) instructs the
  // maintainer to append their verdict, feeding the existing learning loop.
  // Template-driven, render-contract tested like the apply-review follow-up trail.

  function renderIn(ws: string): string {
    const wrap = join(ws, "wrap.md");
    writeFileSync(wrap, `@include:${tpl("quality-report.md")}`, "utf8");
    return renderTemplate(wrap, { INPUTS: "" }, { cwd: ws });
  }

  it("surfaces an existing verdicts trail so prior verdicts feed the next run", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-vt-"));
    try {
      mkdirSync(join(ws, ".otto"), { recursive: true });
      writeFileSync(
        join(ws, ".otto", "verdicts.md"),
        "## 2026-06-16 issue-7\n- Rejected — scope creep, touched unrelated files\n",
        "utf8"
      );
      const out = renderIn(ws);
      expect(out).toContain("scope creep, touched unrelated files");
      expect(out).not.toContain("_No human verdicts recorded yet._");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("falls back gracefully when no verdicts have been recorded yet", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-vt-"));
    try {
      const out = renderIn(ws);
      expect(out).toContain("_No human verdicts recorded yet._");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("instructs the maintainer to record their verdict in a git-tracked trail feeding the learning loop", () => {
    const ws = mkdtempSync(join(tmpdir(), "otto-vt-"));
    try {
      const out = renderIn(ws);
      // The trail file the maintainer appends to...
      expect(out).toContain("./.otto/verdicts.md");
      // ...the four human-verdict labels (note: the HUMAN verdict uses "Needs
      // investigation", distinct from the report's "Needs human review")...
      expect(out).toContain("Needs investigation");
      // ...git-tracked and wired into the existing learning loop so future runs
      // see what was accepted/rejected and why.
      expect(out).toMatch(/git-tracked/);
      expect(out).toMatch(/learning loop/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("cross-run quality summary (verify.md)", () => {
  // Feature 3: beyond a single run's per-plan report, a maintainer wants a
  // quality rollup *across* runs — completion count, common failure causes,
  // outstanding gaps/deferred — so they can spot recurring output-quality
  // failures without reading every NDJSON log. It lives in the read-only
  // verify gate (the only inspection mode) and derives from the git-tracked
  // human-verdict trail (.otto/verdicts.md) verify already surfaces — NOT a new
  // ## section in the shared contract (that would pollute the six-section
  // samples parse and bind a cross-run rollup into the per-run report shape).

  it("instructs verify to roll up quality across runs from the verdict trail", () => {
    const body = readFileSync(tpl("verify.md"), "utf8");
    expect(body).toContain("Cross-Run Quality Summary");
    // Sourced from the git-tracked cross-run record, not the NDJSON logs.
    expect(body).toContain("./.otto/verdicts.md");
    // The dimensions the issue names: completion count, common causes, and
    // outstanding gaps/deferred work.
    const lower = body.toLowerCase();
    expect(lower).toMatch(/completion|tally|per verdict/);
    expect(lower).toMatch(/common cause|recurring/);
    expect(lower).toMatch(/deferred|gap/);
    // Read-only: verify must not mutate the trail.
    expect(lower).toMatch(/read-only|do not edit|do not commit/);
  });

  it("surfaces the cross-run summary when verify renders, staying read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-cr-"));
    try {
      const out = renderTemplate(
        tpl("verify.md"),
        { INPUTS: "plan.md and prd.md", RESUME: "" },
        { cwd: dir }
      );
      expect(out).toContain("Cross-Run Quality Summary");
      expect(out).toContain("./.otto/verdicts.md");
      expect(out).toMatch(/NO commits|Do not commit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
