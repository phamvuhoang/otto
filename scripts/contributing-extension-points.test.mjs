// Documentation contract test for the "Stable extension points" docs in
// CONTRIBUTING.md (plan task 1 of issue #12). Otto's headline adoption signal is
// "a contributor can add a stage, template, or run mode using docs alone." This
// pins that all three extension points are documented, that the run-mode section
// states the gate/reviewer contract the issue says must not break, and that every
// stage name the run-mode section references is a REAL stage parsed from
// stages.ts — so a rename in stages.ts fails this test instead of silently rotting
// the docs. Run via `pnpm test` (node --test). No build / network needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contributing = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
const stagesSrc = readFileSync(
  join(root, "packages", "core", "src", "stages.ts"),
  "utf8"
);

// Parse the real STAGES `name:` values out of stages.ts. This is the source of
// truth the docs must agree with; parsing it (rather than hard-coding names here)
// means a stage rename that isn't mirrored in the docs fails this test.
function stageNames(src) {
  const names = [...src.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(
    names.length >= 4,
    `parsed too few STAGES names (${names.length}) — parser likely out of sync with stages.ts`
  );
  return new Set(names);
}

// Slice from `## <heading>` to the next top-level `## ` heading.
function section(md, heading) {
  const start = md.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `CONTRIBUTING.md is missing a "## ${heading}" section`);
  const rest = md.slice(start + `## ${heading}`.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

test("all three extension points are documented", () => {
  for (const heading of [
    "Adding a pipeline stage",
    "Customizing prompts",
    "Adding a run mode",
  ]) {
    assert.ok(
      contributing.includes(`## ${heading}`),
      `CONTRIBUTING.md is missing the "${heading}" extension-point section`
    );
  }
});

test("run-mode section states the gate/reviewer contract", () => {
  const runMode = section(contributing, "Adding a run mode");
  assert.ok(
    runMode.includes("<promise>NO MORE TASKS</promise>"),
    "run-mode section must restate the gate sentinel <promise>NO MORE TASKS</promise>"
  );
  assert.ok(
    /first stage/i.test(runMode) && /gate/i.test(runMode),
    'run-mode section must state the "first stage is the gate" invariant'
  );
  assert.ok(
    /reviewer/i.test(runMode),
    "run-mode section must explain the reviewer stays the trailing non-gate stage"
  );
});

test("run-mode section names real flags and real STAGES gate stages", () => {
  const runMode = section(contributing, "Adding a run mode");
  const names = stageNames(stagesSrc);

  for (const flag of ["--verify", "--apply-review"]) {
    assert.ok(
      runMode.includes(flag),
      `run-mode section must reference the \`${flag}\` mode flag`
    );
  }

  // The two stages a built-in mode swaps in as the gate. They MUST exist in the
  // real STAGES registry; if stages.ts renames one, this fails and forces a doc
  // (and test) update — the whole point of the contract.
  for (const stage of ["verifier", "apply-review-implementer"]) {
    assert.ok(
      names.has(stage),
      `"${stage}" referenced by the docs is not a real STAGES name (stages.ts drift)`
    );
    assert.ok(
      runMode.includes(stage),
      `run-mode section must name the "${stage}" gate stage`
    );
  }
});
