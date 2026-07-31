import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tpl = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../templates/${name}`, import.meta.url)),
    "utf8"
  );

/**
 * P29 Task 6 — static-first entry templates.
 *
 * The ~400-line playbook chain is identical on every iteration; the dynamic
 * blocks are not. Rendering the static chain FIRST gives the prompt a stable
 * leading prefix that the runtime's prompt cache can reuse across iterations
 * and stages (measured via `cache_read_input_tokens`, tokens.ts:38).
 */
describe("static-first entry templates (P29 cache shape)", () => {
  const cases: { file: string; include: string; dynamic: string[] }[] = [
    {
      file: "afk.md",
      include: "@include:prompt.md",
      dynamic: ["{{ RESUME }}", "<commits>", "<learnings>", "<inputs>"],
    },
    {
      file: "ghafk.md",
      include: "@include:ghprompt.md",
      dynamic: [
        "{{ RESUME }}",
        "<commits>",
        "<learnings>",
        "<issues-summary>",
        "<issues-full-file>",
      ],
    },
    {
      file: "ghafk-issue.md",
      include: "@include:ghprompt-workflow.md",
      dynamic: ["<commits>", "<learnings>", "<issue>", "# THE TASK"],
    },
  ];

  for (const { file, include, dynamic } of cases) {
    it(`${file} renders its playbook include before every dynamic block`, () => {
      const raw = tpl(file);
      const at = raw.indexOf(include);
      expect(at, `${file} still contains ${include}`).toBeGreaterThanOrEqual(0);
      for (const block of dynamic) {
        const blockAt = raw.indexOf(block);
        expect(blockAt, `${file} still contains ${block}`).toBeGreaterThan(-1);
        expect(at, `${include} must precede ${block}`).toBeLessThan(blockAt);
      }
    });
  }

  it("ghafk-issue.md keeps <issue> before the prose that says 'shown above'", () => {
    // The reorder moves only the trailing include; intra-file block order must
    // survive or this sentence points at nothing.
    const raw = tpl("ghafk-issue.md");
    expect(raw.indexOf("<issue>")).toBeLessThan(raw.indexOf("(shown above)"));
  });

  it("ghafk.md keeps <issues-summary> before the prose that references it", () => {
    const raw = tpl("ghafk.md");
    expect(raw.indexOf("<issues-summary>")).toBeLessThan(
      raw.indexOf("block above is the lean index")
    );
  });

  it("ghprompt.md no longer says 'the issue list above'", () => {
    // It is now the FIRST thing in the prompt, so nothing precedes it.
    expect(tpl("ghprompt.md")).not.toContain("issue list above");
    expect(tpl("ghprompt.md")).toContain("blocks in this prompt");
  });
});

describe("no positional claim contradicts the static-first order", () => {
  // The Step 0 audit regex ("above|below|earlier|preceding|following") missed
  // this phrasing entirely. It was only caught by rendering the prompt and
  // reading its first line, where the playbook still claimed <inputs> was "at
  // the start of context" — it is now at the end.
  const POSITIONAL =
    /\b(at the start of context|at the end of context|top of the prompt|bottom of the prompt)\b/i;

  const reordered = [
    { file: "prompt.md", via: "afk.md" },
    { file: "ghprompt.md", via: "ghafk.md" },
    { file: "ghprompt-workflow.md", via: "ghafk-issue.md" },
  ];

  for (const { file, via } of reordered) {
    it(`${file} makes no start-of-context claim (${via} is static-first)`, () => {
      const hits = tpl(file)
        .split("\n")
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => POSITIONAL.test(l));
      expect(hits.map((h) => `${file}:${h.n}`)).toEqual([]);
    });
  }

  it("linearprompt.md may still say it — linearafk.md is NOT reordered", () => {
    // Guards the inverse mistake: blanket-rewriting a claim that is still true.
    // If linearafk.md is ever reordered, this test fails and forces the fix.
    const linearIsStaticFirst =
      tpl("linearafk.md").indexOf("@include:linearprompt.md") <
      tpl("linearafk.md").indexOf("<commits>");
    expect(linearIsStaticFirst).toBe(false);
    expect(tpl("linearprompt.md")).toContain("at the start of context");
  });
});
