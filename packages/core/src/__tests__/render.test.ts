import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate } from "../render.js";

describe("renderTemplate generic vars", () => {
  it("substitutes arbitrary {{ KEY }} vars and leaves unknown tags", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-render-"));
    const tpl = join(dir, "t.md");
    writeFileSync(
      tpl,
      "lens={{ LENS }} in={{ INPUTS }} keep={{ UNKNOWN }}",
      "utf8"
    );
    const out = renderTemplate(tpl, { LENS: "security", INPUTS: "plan" });
    expect(out).toBe("lens=security in=plan keep={{ UNKNOWN }}");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("renderTemplate @include", () => {
  it("resolves nested @include chains, each hop relative to its own file", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-include-"));
    mkdirSync(join(dir, "sub"), { recursive: true });
    // A -> sub/B -> ../C : the relative hops pin per-level fromDir resolution.
    writeFileSync(join(dir, "A.md"), "@include:sub/B.md", "utf8");
    writeFileSync(join(dir, "sub", "B.md"), "@include:../C.md", "utf8");
    writeFileSync(join(dir, "C.md"), "DEEP_MARKER", "utf8");
    const out = renderTemplate(join(dir, "A.md"), {});
    expect(out).toContain("DEEP_MARKER");
    rmSync(dir, { recursive: true, force: true });
  });
});
