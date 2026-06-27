// Deterministic (no-model) eval for P24 verification coverage (#181): the
// roadmap's metric "reports include at least one verification artifact for tasks
// where a concrete artifact is feasible" (% reports with a verification
// artifact), proven in CI without paying for a model run. Reads the
// benchmarks/fixtures/verification-coverage fixtures and asserts, through the
// published package, that the coverage gate distinguishes an unproven matrix
// (claims with no artifacts) from a proven one (every claim artifact-backed),
// and that artifact coverage rises between them. The paid half (replaying
// otto-afk --verify against a real model and scoring the authored matrix) is
// intentionally not run in CI. Run via `pnpm test` (node --test); needs
// `pnpm -r build` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseVerificationMatrix,
  scoreVerificationCoverage,
} from "../packages/core/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(
  root,
  "benchmarks",
  "fixtures",
  "verification-coverage"
);
const read = (name) =>
  parseVerificationMatrix(readFileSync(join(fixtureDir, name), "utf8"));

const unproven = read("unproven-matrix.json");
const proven = read("proven-matrix.json");

test("both fixtures parse to the same three requirements", () => {
  assert.equal(unproven.length, 3);
  assert.equal(proven.length, 3);
  assert.deepEqual(
    unproven.map((e) => e.requirement).sort(),
    proven.map((e) => e.requirement).sort()
  );
});

test("the unproven matrix FAILS the coverage gate, naming the gaps", () => {
  const g = scoreVerificationCoverage(unproven);
  assert.equal(g.passed, false);
  assert.equal(g.coverage, 0);
  assert.ok(g.unproven.length >= 1, "expected unproven requirements");
  assert.ok(
    g.failed.includes("rounding matches the spec"),
    "expected the failed requirement to be named"
  );
});

test("citing an artifact for each requirement PASSES the gate (the P24 metric)", () => {
  const g = scoreVerificationCoverage(proven);
  assert.equal(g.passed, true);
  assert.equal(g.coverage, 1);
  assert.deepEqual(g.unproven, []);
  assert.deepEqual(g.failed, []);
});

test("artifact coverage rises from the unproven matrix to the proven one", () => {
  const before = scoreVerificationCoverage(unproven).coverage;
  const after = scoreVerificationCoverage(proven).coverage;
  assert.ok(
    after > before,
    `expected coverage to rise, got ${before} -> ${after}`
  );
});
