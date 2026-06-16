// Documentation contract test for the beta-feedback cycle (plan task 4 of issue
// #12). Issue #12's fourth initiative is "run a beta feedback cycle: recruit a
// small set of maintainers to try real repos, capture setup friction, confusing
// docs, and unsafe defaults" with the success signal "beta feedback produces a
// ranked backlog for the following quarter."
//
// That is a process activity, not runtime code, so it ships as two artifacts:
//   - .github/ISSUE_TEMPLATE/beta-feedback.md — the structured CAPTURE form a
//     beta tester fills in (setup friction / confusing docs / unsafe defaults),
//     consistent with the existing bug_report + feature_request templates.
//   - docs/BETA.md — the program doc + the RANKING rubric that turns captured
//     feedback into a ranked backlog, linking back to the capture template.
//
// This test pins both so the beta program can't silently lose its capture
// dimensions or its ranking rubric. Run via `pnpm test` (node --test). No build
// or network — reads the two files directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/beta-feedback.md";
const BETA_DOC_PATH = "docs/BETA.md";

// The three feedback dimensions the issue names verbatim. The capture template
// must solicit each; the ranking rubric in docs/BETA.md must reference them too.
const CAPTURE_DIMENSIONS = [
  "setup friction",
  "confusing docs",
  "unsafe defaults",
];

// Parse the leading `--- ... ---` YAML frontmatter block into a flat string map.
function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, "issue template is missing its `--- ... ---` frontmatter block");
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

test("beta-feedback issue template captures the three named dimensions", () => {
  const tmpl = read(TEMPLATE_PATH);
  const fm = frontmatter(tmpl);

  // Frontmatter shape mirrors the other ISSUE_TEMPLATE forms so GitHub renders
  // it as a chooser entry and auto-labels filed feedback.
  assert.ok(fm.name, "beta-feedback template frontmatter must set `name:`");
  assert.ok(fm.about, "beta-feedback template frontmatter must set `about:`");
  assert.match(
    fm.labels || "",
    /\bbeta\b/,
    "beta-feedback template must carry the `beta` label so feedback is filterable"
  );

  const lower = tmpl.toLowerCase();
  for (const dim of CAPTURE_DIMENSIONS) {
    assert.ok(
      lower.includes(dim),
      `beta-feedback template must solicit "${dim}"`
    );
  }
});

test("docs/BETA.md defines a ranking rubric and links to the capture template", () => {
  const doc = read(BETA_DOC_PATH);
  const lower = doc.toLowerCase();

  // The headline success signal: feedback produces a *ranked backlog*.
  assert.ok(
    lower.includes("ranked backlog"),
    "docs/BETA.md must state the goal: feedback produces a ranked backlog"
  );
  assert.ok(
    /\brubric\b/i.test(doc) || /\brank(ing|ed)?\b/i.test(doc),
    "docs/BETA.md must describe how feedback is ranked (a rubric)"
  );

  // The program doc must point at the capture form so the two artifacts stay
  // joined — a reader of BETA.md can find where to file feedback.
  assert.ok(
    doc.includes("beta-feedback"),
    "docs/BETA.md must link to the beta-feedback issue template"
  );

  // The rubric ranks along the dimensions the template captures.
  for (const dim of CAPTURE_DIMENSIONS) {
    assert.ok(
      lower.includes(dim),
      `docs/BETA.md must reference the "${dim}" feedback dimension`
    );
  }
});
