// Documentation contract test for the "Worked recipes" section of docs/CLI.md
// (plan task 3 of issue #8). Pins that the three maintainer recipes — issue
// burn-down, external-review repair, and overnight run — each ship a
// copy-pasteable command block plus an example end-state summary line, so a
// maintainer can pick a workflow without reading source. Run via `pnpm test`
// (node --test). No build / network needed; reads the markdown directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = readFileSync(join(root, "docs", "CLI.md"), "utf8");

// Slice from the "## Worked recipes" heading to the next top-level "## " heading.
function recipesSection(md) {
  const start = md.indexOf("## Worked recipes");
  assert.notEqual(start, -1, 'docs/CLI.md is missing a "## Worked recipes" section');
  const rest = md.slice(start + "## Worked recipes".length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

test("Worked recipes section has the three named recipes", () => {
  const section = recipesSection(cli);
  for (const heading of [
    "Issue burn-down",
    "External-review repair",
    "Overnight run",
  ]) {
    assert.ok(
      section.includes(`### ${heading}`),
      `Worked recipes is missing the "${heading}" recipe heading`
    );
  }
});

test("each recipe ships a fenced command block and an end-state summary", () => {
  const section = recipesSection(cli);
  // Each recipe drives a distinct mode.
  for (const command of ["otto-ghafk", "--apply-review", "--detach"]) {
    assert.ok(
      section.includes(command),
      `Worked recipes is missing the \`${command}\` command`
    );
  }
  // Three example end-state summaries — the real `summarize()` format — so a
  // maintainer knows what "done" looks like for each recipe.
  const summaries = section.match(/● Otto /g) ?? [];
  assert.ok(
    summaries.length >= 3,
    `expected ≥3 example "● Otto …" summary lines, found ${summaries.length}`
  );
  // Each summary pairs with its actionable "→ next:" hint.
  const hints = section.match(/→ next:/g) ?? [];
  assert.ok(
    hints.length >= 3,
    `expected ≥3 "→ next:" hint lines, found ${hints.length}`
  );
});
