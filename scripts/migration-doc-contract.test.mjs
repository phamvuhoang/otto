// Documentation contract test for docs/MIGRATION.md (issue #21 P4 — migration +
// docs). Pins that the artifact-naming migration doc ships the old→new path
// mapping, the task-grouped layout, the compatibility (legacy-read) guarantee,
// manual migration steps, the branch-convention namespace, and the "everything
// Otto knows about issue X" answer. Drift-proof: the NEW paths it asserts are
// extracted from the real templates (superpowers.md / apply-review.md), so a
// template path change that isn't mirrored in the doc fails this test rather
// than silently going stale (same philosophy as quality-report-samples.test.mjs
// parsing the real contract). Run via `pnpm test` (node --test); no build/network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(join(root, "docs", "MIGRATION.md"), "utf8");
const templates = join(root, "packages", "core", "templates");
const superpowers = readFileSync(join(templates, "superpowers.md"), "utf8");
const applyReview = readFileSync(join(templates, "apply-review.md"), "utf8");

// The task-grouped paths the live templates actually WRITE today. These are the
// source of truth; the doc must document each.
const NEW_PATHS = [
  ".otto/tasks/<task-key>/spec.md",
  ".otto/tasks/<task-key>/plan.md",
  ".otto/tasks/<task-key>/followups.md",
];

test("the new task-grouped paths the doc documents match the live templates", () => {
  // Guard the anchors: if a template stops writing one of these, this test (not
  // just the doc) breaks, forcing both to move together.
  assert.ok(
    superpowers.includes(".otto/tasks/<task-key>/spec.md"),
    "superpowers.md no longer writes .otto/tasks/<task-key>/spec.md — update the anchor"
  );
  assert.ok(
    superpowers.includes(".otto/tasks/<task-key>/plan.md"),
    "superpowers.md no longer writes .otto/tasks/<task-key>/plan.md — update the anchor"
  );
  assert.ok(
    applyReview.includes(".otto/tasks/<task-key>/followups.md"),
    "apply-review.md no longer writes .otto/tasks/<task-key>/followups.md — update the anchor"
  );
  for (const p of NEW_PATHS) {
    assert.ok(
      doc.includes(p),
      `MIGRATION.md is missing the new task-grouped path \`${p}\``
    );
  }
});

test("doc maps every legacy flat path to its new home", () => {
  // The old layout the compatibility reader still falls back to.
  for (const legacy of [
    ".otto/specs/",
    ".otto/plans/",
    ".otto/review-followups.md",
  ]) {
    assert.ok(
      doc.includes(legacy),
      `MIGRATION.md is missing the legacy path \`${legacy}\` in its old→new mapping`
    );
  }
});

test("doc states the legacy-read compatibility guarantee", () => {
  const lower = doc.toLowerCase();
  assert.ok(
    /legacy|old/.test(lower) && /fallback|read/.test(lower),
    "MIGRATION.md must state that old paths are READ as a fallback"
  );
  assert.ok(
    /one release/.test(lower),
    "MIGRATION.md must state the legacy-read lasts at least one release"
  );
});

test("doc ships manual migration steps", () => {
  const start = doc.indexOf("## Migrat");
  assert.notEqual(
    start,
    -1,
    'MIGRATION.md is missing a "## Migrat…" (manual migration) section'
  );
});

test("doc documents the branch-convention namespace", () => {
  assert.ok(
    doc.includes("--branch-convention") &&
      doc.includes("<branch-convention>/<task-key>"),
    "MIGRATION.md must document the <branch-convention>/<task-key> branch namespace"
  );
});

test('doc answers "everything Otto knows about issue X"', () => {
  // The whole task dir is the answer; the doc must show how to list it.
  assert.ok(
    doc.includes(".otto/tasks/<task-key>/") &&
      /everything otto knows/i.test(doc),
    'MIGRATION.md must show how to find "everything Otto knows" about a task (its .otto/tasks/<task-key>/ dir)'
  );
});
