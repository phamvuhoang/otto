import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../render.js";

const tpl = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

describe("always-on superpowers fragment", () => {
  it("is included by the afk and ghafk-workflow playbooks", () => {
    for (const name of ["prompt.md", "ghprompt-workflow.md"]) {
      const body = readFileSync(tpl(name), "utf8");
      expect(body).toContain("@include:superpowers.md");
    }
  });

  it("renders the CLARITY GATE marker when its include is resolved", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-sp-"));
    const wrap = join(dir, "wrap.md");
    // Absolute include path -> renderTemplate reads the real fragment.
    writeFileSync(wrap, `@include:${tpl("superpowers.md")}`, "utf8");
    const out = renderTemplate(wrap, { INPUTS: "" });
    expect(out).toContain("CLARITY GATE");
    expect(out).toContain("AUTONOMOUS BRAINSTORM");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("task-grouped artifact layout (issue #21 P2)", () => {
  // P2 item 1: per-task artifacts live together under .otto/tasks/<task-key>/.
  // The layout is agent/template-driven (no otto code writes spec/plan), so it is
  // pinned at the template-contract level: the workflow must WRITE the new
  // task-grouped paths and still READ the legacy flat layout as a fallback so an
  // in-flight task created before the change continues without re-brainstorming.
  const body = readFileSync(tpl("superpowers.md"), "utf8");

  it("writes spec and plan under the task-grouped directory", () => {
    expect(body).toContain(".otto/tasks/<task-key>/spec.md");
    expect(body).toContain(".otto/tasks/<task-key>/plan.md");
  });

  it("keeps reading the legacy flat layout as a fallback", () => {
    expect(body).toContain(".otto/specs/<task-key>-design.md");
    expect(body).toContain(".otto/plans/<task-key>.md");
  });
});
