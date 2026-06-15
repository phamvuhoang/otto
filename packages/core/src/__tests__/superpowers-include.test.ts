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
