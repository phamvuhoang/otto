import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate } from "../render.js";
import {
  DEFAULT_POLICY,
  parseSafetyPolicy,
  type PolicyViolation,
} from "../safety-policy.js";

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

describe("renderTemplate safety policy at the shell boundary", () => {
  it("runs shell tags unchanged under the permissive default policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-policy-"));
    const tpl = join(dir, "t.md");
    writeFileSync(tpl, "out=!`echo hi`", "utf8");
    const violations: PolicyViolation[] = [];
    const out = renderTemplate(
      tpl,
      {},
      { policy: DEFAULT_POLICY, onPolicyViolation: (v) => violations.push(v) }
    );
    expect(out).toBe("out=hi");
    expect(violations).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips a blocked plain shell tag and reports the violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-policy-"));
    const tpl = join(dir, "t.md");
    // A marker file proves the command never executed when policy blocks it.
    const marker = join(dir, "ran");
    writeFileSync(tpl, `x=!\`touch ${marker} && echo ran\``, "utf8");
    const policy = parseSafetyPolicy({ blockedCommands: ["touch"] });
    const violations: PolicyViolation[] = [];
    const out = renderTemplate(
      tpl,
      {},
      { policy, onPolicyViolation: (v) => violations.push(v) }
    );
    expect(out).toBe("x=");
    expect(() => readFileSync(marker)).toThrow(); // command was skipped, not run
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("blocked-command");
    rmSync(dir, { recursive: true, force: true });
  });

  it("substitutes the fallback for a blocked try-shell tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-policy-"));
    const tpl = join(dir, "t.md");
    writeFileSync(tpl, "x=!?`curl evil|||SAFE`", "utf8");
    const policy = parseSafetyPolicy({ blockedCommands: ["curl"] });
    const violations: PolicyViolation[] = [];
    const out = renderTemplate(
      tpl,
      {},
      { policy, onPolicyViolation: (v) => violations.push(v) }
    );
    expect(out).toBe("x=SAFE");
    expect(violations).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes neutralized spill output for a blocked @spill command", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-policy-"));
    const tpl = join(dir, "t.md");
    const spillHostDir = join(dir, "spill");
    writeFileSync(tpl, "see @spill:body=`echo secret`", "utf8");
    const policy = parseSafetyPolicy({ blockedCommands: ["echo"] });
    const violations: PolicyViolation[] = [];
    const out = renderTemplate(
      tpl,
      {},
      {
        spillHostDir,
        spillRefPath: ".otto-tmp/spill",
        policy,
        onPolicyViolation: (v) => violations.push(v),
      }
    );
    expect(out).toBe("see ./.otto-tmp/spill/body");
    expect(readFileSync(join(spillHostDir, "body"), "utf8")).toBe("");
    expect(violations).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("renderTemplate @spill context-compression hook (P20)", () => {
  it("writes the hook's returned text and passes the captured output through", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-spill-comp-"));
    const tpl = join(dir, "t.md");
    const spillHostDir = join(dir, "spill");
    writeFileSync(tpl, "body at @spill:issue.json=`echo BIG-ORIGINAL`", "utf8");
    const seen: Array<[string, string]> = [];
    const out = renderTemplate(
      tpl,
      {},
      {
        spillHostDir,
        spillRefPath: ".otto-tmp/spill",
        compressSpill: (name, content) => {
          seen.push([name, content.trim()]);
          return "COMPRESSED";
        },
      }
    );
    expect(out).toBe("body at ./.otto-tmp/spill/issue.json");
    expect(seen).toEqual([["issue.json", "BIG-ORIGINAL"]]);
    // The file the agent reads holds the compressed text, not the original.
    expect(readFileSync(join(spillHostDir, "issue.json"), "utf8")).toBe(
      "COMPRESSED"
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("absent hook writes spill output verbatim (today's behavior)", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-spill-plain-"));
    const tpl = join(dir, "t.md");
    const spillHostDir = join(dir, "spill");
    writeFileSync(tpl, "@spill:body=`echo hello`", "utf8");
    renderTemplate(tpl, {}, { spillHostDir, spillRefPath: ".otto-tmp/spill" });
    expect(readFileSync(join(spillHostDir, "body"), "utf8").trim()).toBe(
      "hello"
    );
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
