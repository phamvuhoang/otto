import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";
import { STAGES } from "../stages.js";

// Render-contract tests for the Linear AFK stages/templates. They pin two things
// the renderer + run-bin rely on but no unit test of linear-api would catch:
//   1. the templates surface the spilled issue file so the agent reads bodies
//      from a file rather than from an inlined blob, and
//   2. the SECURITY INVARIANT from render.ts holds — runtime data ({{ INPUTS }})
//      never reaches a host shell command body; the only runtime reference in a
//      shell/spill tag is the $OTTO_ISSUE env var, which run-bin validates via
//      parseLinearRef before exporting (admits only [A-Z0-9-]).

const tpl = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

// Mirror render.ts's tag regexes to pull out command bodies that hit the shell.
const SHELL_TRY = /!\?`([^`]+)`/g;
const SHELL = /!`([^`]+)`/g;
const SPILL = /@spill\??:[^\s=]+=`([^`]+)`/g;

function shellCommandBodies(text: string): string[] {
  const bodies: string[] = [];
  for (const re of [SHELL_TRY, SHELL, SPILL]) {
    for (const m of text.matchAll(re)) bodies.push(m[1]);
  }
  return bodies;
}

function render(name: string, vars: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-lt-"));
  try {
    return renderTemplate(
      tpl(name),
      { INPUTS: "ENG-123", RESUME: "", ...vars },
      { spillHostDir: dir, spillRefPath: "./.otto-tmp/spill" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Linear AFK stages", () => {
  it("registers linearImplementer/linearIssueImplementer pointing at the Linear templates", () => {
    expect(STAGES.linearImplementer).toMatchObject({
      name: "linear-implementer",
      template: "linearafk.md",
      permissionMode: "bypassPermissions",
    });
    expect(STAGES.linearIssueImplementer).toMatchObject({
      name: "linear-issue-implementer",
      template: "linearafk-issue.md",
      permissionMode: "bypassPermissions",
    });
  });
});

describe("Linear AFK templates", () => {
  it("drive the bundled `otto-linear` helper, not `gh`", () => {
    for (const name of ["linearafk.md", "linearafk-issue.md"]) {
      const body = readFileSync(tpl(name), "utf8");
      expect(body).toContain("otto-linear");
      expect(body).not.toMatch(/\bgh issue\b/);
    }
  });

  it("compose the shared playbook fragments (reuse, no duplication)", () => {
    expect(readFileSync(tpl("linearafk.md"), "utf8")).toContain(
      "@include:linearprompt.md"
    );
    // Both the multi-issue playbook and the single-issue template reuse the
    // provider-agnostic workflow fragment rather than forking it.
    expect(readFileSync(tpl("linearprompt.md"), "utf8")).toContain(
      "@include:ghprompt-workflow.md"
    );
    expect(readFileSync(tpl("linearafk-issue.md"), "utf8")).toContain(
      "@include:ghprompt-workflow.md"
    );
  });

  it("encode the Linear completion behaviour (comment vs. otto-linear done) in the playbook", () => {
    // Both Linear entry points reach the completion fragment exactly once:
    // linearafk.md → linearprompt.md, and linearafk-issue.md directly.
    for (const entry of ["linearprompt.md", "linearafk-issue.md"]) {
      expect(readFileSync(tpl(entry), "utf8")).toContain(
        "@include:linear-completion.md"
      );
    }
    const completion = readFileSync(tpl("linear-completion.md"), "utf8");
    expect(completion).toContain("otto-linear done");
    expect(completion).toContain("otto-linear comment");
    expect(completion).toContain("OTTO_LINEAR_DONE_STATE");
  });

  it("surface the spilled issue file so the agent reads detail from a file", () => {
    const multi = render("linearafk.md", {});
    expect(multi).toContain("./.otto-tmp/spill/issues.json");
    const single = render("linearafk-issue.md", {});
    expect(single).toContain("./.otto-tmp/spill/issue.json");
  });

  it("scope the single-issue template to {{ INPUTS }} and keep the gate sentinel", () => {
    const single = render("linearafk-issue.md", {});
    expect(single).toContain("ENG-123");
    expect(single).toContain("NO MORE TASKS");
  });

  it("never interpolate a template var into a host shell command (RCE invariant)", () => {
    for (const name of ["linearafk.md", "linearafk-issue.md", "linearprompt.md"]) {
      const raw = readFileSync(tpl(name), "utf8");
      for (const body of shellCommandBodies(raw)) {
        // {{ ... }} is substituted LAST, into already-expanded text, and never
        // re-shelled — so no shell/spill command body may embed one.
        expect(body).not.toMatch(/\{\{/);
      }
    }
  });

  it("only ever reference the validated $OTTO_ISSUE env var inside shell tags", () => {
    const raw = readFileSync(tpl("linearafk-issue.md"), "utf8");
    for (const body of shellCommandBodies(raw)) {
      const envRefs = body.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      for (const ref of envRefs) {
        expect(ref).toBe("$OTTO_ISSUE");
      }
    }
  });
});
