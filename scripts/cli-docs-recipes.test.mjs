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
// NEXT_ACTION map moved to next-action.ts; loopSrc still points to loop.ts
// for the deferred-follow-up tally check (which remains in loop.ts).
const loopSrc = readFileSync(
  join(root, "packages", "core", "src", "loop.ts"),
  "utf8"
);
const nextActionSrc = readFileSync(
  join(root, "packages", "core", "src", "next-action.ts"),
  "utf8"
);

// Slice from the "## Worked recipes" heading to the next top-level "## " heading.
function recipesSection(md) {
  const start = md.indexOf("## Worked recipes");
  assert.notEqual(start, -1, 'docs/CLI.md is missing a "## Worked recipes" section');
  const rest = md.slice(start + "## Worked recipes".length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

// Parse the `NEXT_ACTION` map out of loop.ts source into {reason: hint}. This is
// the source of truth `nextActionFor()` reads; parsing it (rather than building
// a string this test) means a hint edit in loop.ts that isn't mirrored in the
// docs fails this test instead of silently drifting.
function nextActionMap(src) {
  const block = src.match(
    /const NEXT_ACTION: Record<string, string> = \{([\s\S]*?)\n\};/
  );
  assert.ok(block, "could not locate the NEXT_ACTION map in loop.ts");
  const map = {};
  // key (bare word or "quoted, with spaces") : "value" — value may sit on the
  // next line for long entries.
  const entry = /(?:"([^"]+)"|(\w+))\s*:\s*\n?\s*"([^"]+)"/g;
  let m;
  while ((m = entry.exec(block[1])) !== null) {
    map[m[1] ?? m[2]] = m[3];
  }
  assert.ok(
    Object.keys(map).length >= 5,
    `parsed too few NEXT_ACTION entries (${Object.keys(map).length}) — parser likely out of sync with loop.ts`
  );
  return map;
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

test("each recipe ships the command for its distinct mode", () => {
  const section = recipesSection(cli);
  // Each recipe drives a distinct mode.
  for (const command of ["otto-ghafk", "--apply-review", "--detach"]) {
    assert.ok(
      section.includes(command),
      `Worked recipes is missing the \`${command}\` command`
    );
  }
});

// Match a concrete example summary block: the `● Otto <reason> · N iterations ·
// $cost` line paired with its `→ next: <hint>` line. The literal `\d+`/`\$[\d.]+`
// in the pattern excludes the section's intro prose (which uses the placeholders
// `N iterations`/`$cost`), so this counts real examples only — not template text.
const EXAMPLE_BLOCK =
  /● Otto (.+?) · \d+ iterations? · \$[\d.]+\n\s*→ next: (.+)/g;

test("each documented summary/hint matches summarize()/nextActionFor()", () => {
  const section = recipesSection(cli);
  const map = nextActionMap(nextActionSrc);

  const blocks = [...section.matchAll(EXAMPLE_BLOCK)];
  assert.ok(
    blocks.length >= 3,
    `expected ≥3 concrete "● Otto … → next:" example blocks, found ${blocks.length}`
  );

  for (const [, reason, hint] of blocks) {
    assert.ok(
      reason in map,
      `documented summary reason "${reason}" is not a known summarize() exit reason`
    );
    assert.equal(
      hint.trim(),
      map[reason],
      `documented "→ next:" hint for "${reason}" has drifted from nextActionFor()`
    );
  }
});

test("documented deferred-follow-up tally matches summarize()'s format", () => {
  const section = recipesSection(cli);
  // The real line summarize() writes when deferred follow-ups exist.
  const docLine = section.match(
    /⚑ \d+ deferred follow-ups? in \.otto\/review-followups\.md/
  );
  assert.ok(
    docLine,
    "Worked recipes is missing an example ⚑ deferred-follow-up tally line"
  );
  assert.ok(
    loopSrc.includes("deferred follow-up") &&
      loopSrc.includes("in .otto/review-followups.md"),
    "summarize() in loop.ts no longer emits the documented ⚑ tally format"
  );
});
