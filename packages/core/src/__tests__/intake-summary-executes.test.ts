import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression tests for the inert `<issues-summary>` defect (issue #253).
 *
 * `ghafk.md` and `linearafk.md` carried their summary command as a BARE
 * backticked string. `render.ts`'s tag regexes both require a `!` prefix
 * (`SHELL_TRY_TAG` / `SHELL_TAG`), so neither matched: the block injected the
 * literal command text and never any issue data, while the prose below it told
 * the agent it was "the lean index for triage".
 */

const templatesDir = fileURLToPath(new URL("../../templates", import.meta.url));
const tpl = (name: string) => readFileSync(`${templatesDir}/${name}`, "utf8");

const summaryBlock = (name: string): string => {
  const m = tpl(name).match(/<issues-summary>([\s\S]*?)<\/issues-summary>/);
  expect(m, `${name} has an <issues-summary> block`).not.toBeNull();
  return m![1];
};

describe("intake <issues-summary> is actually executed (#253)", () => {
  it("ghafk.md runs a try-shell tag with a JSON fallback", () => {
    const s = summaryBlock("ghafk.md");
    expect(s).toMatch(/!\?`gh issue list /);
    expect(s).toContain("|||[]");
    // The defect itself: a bare backticked command the renderer never executes.
    expect(s).not.toMatch(/^\s*`gh issue list/m);
  });

  it("ghafk.md keeps the inline payload lean: number/title/label NAMES only", () => {
    const s = summaryBlock("ghafk.md");
    expect(s).toContain("--json number,title,labels");
    // Without --jq, `labels` yields full objects (id/description/color) per label.
    expect(s).toContain("--jq");
    expect(s).toContain("[.labels[].name]");
    expect(s).not.toContain("body");
    expect(s).not.toContain("comments");
  });

  it("linearafk.md runs a try-shell tag with a prose fallback", () => {
    const s = summaryBlock("linearafk.md");
    expect(s).toMatch(/!\?`otto-linear list /);
    expect(s).toContain("|||No open Linear issues available.");
    expect(s).not.toMatch(/^\s*`otto-linear list/m);
  });

  it("the full-dump spill stays separate and unchanged", () => {
    // The two-view model: a lean executed index inline, bodies/comments spilled.
    expect(tpl("ghafk.md")).toMatch(
      /@spill\?:issues\.json=`gh issue list .*--json number,title,body,labels,comments/
    );
    expect(tpl("linearafk.md")).toMatch(
      /@spill\?:issues\.json=`otto-linear dump/
    );
  });
});

describe("no shipped template injects a command as literal text", () => {
  it("a standalone backticked shell command must carry a ! prefix", () => {
    // The defect's exact shape: a line that is ENTIRELY a backticked command,
    // which reads like a tag but renders as literal text. Prose that merely
    // opens with an inline code span (e.g. "`git branch --show-current` and
    // take the final segment") is documentation, not a tag, so the whole-line
    // anchor is what separates the two.
    const STANDALONE_BACKTICK = /^`([^`]+)`$/;
    const COMMAND_WORD =
      /^(gh|git|otto-linear|otto-afk|pnpm|npm|npx|node|cat|ls|sh|bash|curl|jq)\s/;
    const offenders: string[] = [];
    for (const name of readdirSync(templatesDir)) {
      if (!name.endsWith(".md")) continue;
      tpl(name)
        .split("\n")
        .forEach((line, i) => {
          const m = line.trim().match(STANDALONE_BACKTICK);
          if (m && COMMAND_WORD.test(m[1])) {
            offenders.push(`${name}:${i + 1} ${line.trim().slice(0, 60)}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
