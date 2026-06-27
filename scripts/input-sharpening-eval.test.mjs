// Deterministic (no-model) eval for P23 input sharpening (#180): the roadmap's
// success metric "plan depth score increases on vague-input fixtures", proven in
// CI without paying for a model run. Reads the benchmarks/fixtures/input-sharpening
// fixtures and asserts, through the published package, that:
//   1. the vague input scores low on the input-sharpness rubric and flags the
//      dimensions the sharpened plan goes on to fill;
//   2. addressing those flagged gaps — as the --sharpen-input guidance directs —
//      raises BOTH the plan-quality and the plan-depth rubric scores.
// The paid half (replaying otto-afk --plan --sharpen-input against a real model
// and scoring the authored plan) is intentionally not run in CI. Run via
// `pnpm test` (node --test); needs `pnpm -r build` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  scoreInputSharpness,
  scorePlanDepth,
  scorePlanQuality,
} from "../packages/core/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(root, "benchmarks", "fixtures", "input-sharpening");
const read = (name) => readFileSync(join(fixtureDir, name), "utf8");

const vagueInput = read("vague-input.md");
const baseline = read("plan-baseline.md");
const sharpened = read("plan-sharpened.md");

test("the vague-input fixture scores low and flags the gaps a sharpening pass must fill", () => {
  const s = scoreInputSharpness(vagueInput);
  // A genuinely thin input: well under half the dimensions present.
  assert.ok(
    s.ratio <= 0.4,
    `expected a low sharpness ratio, got ${s.ratio} (${s.metCount}/${s.maxScore})`
  );
  // The gaps the rubric flags include the dimensions the sharpened plan adds.
  for (const dim of [
    "Constraints / requirements",
    "Success criteria / acceptance",
    "Scope / non-goals",
  ]) {
    assert.ok(s.unknowns.includes(dim), `expected unknown: ${dim}`);
  }
});

test("addressing the flagged gaps raises the plan-quality rubric score", () => {
  const base = scorePlanQuality(baseline);
  const sharp = scorePlanQuality(sharpened);
  assert.ok(
    sharp.metCount > base.metCount,
    `expected sharpened plan-quality to beat baseline, got ${sharp.metCount} vs ${base.metCount}`
  );
  // The baseline is missing exactly the dimensions the input left open — the
  // gaps the sharpening guidance directs the author to record as assumptions.
  for (const label of [
    "Decisions / assumptions",
    "Scope guard / non-goals",
    "Testable success criteria",
  ]) {
    assert.ok(base.missing.includes(label), `baseline should miss: ${label}`);
    assert.ok(
      !sharp.missing.includes(label),
      `sharpened should cover: ${label}`
    );
  }
});

test("plan depth rises on the vague-input fixture once sharpened (the P23 metric)", () => {
  const base = scorePlanDepth(baseline);
  const sharp = scorePlanDepth(sharpened);
  assert.ok(
    sharp.ratio > base.ratio,
    `expected sharpened plan depth to exceed baseline, got ${sharp.ratio} vs ${base.ratio}`
  );
  // The sharpened plan is concretely deep: real file map, every task names a
  // failing test + verify command, testable success criteria.
  assert.equal(
    sharp.metCount,
    sharp.maxScore,
    "sharpened plan should be fully deep"
  );
});
