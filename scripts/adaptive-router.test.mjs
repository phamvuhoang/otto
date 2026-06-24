// Deterministic CI guard for the adaptive compute router's decision substrate
// (issue #41). The router's review-depth routing and early-stop policy are pure
// functions of model-free signals, so CI can exercise the whole decision path
// through the published package — no model calls. The loop wiring is unit-tested
// in vitest; this pins that the substrate is exported and composes end-to-end.
// Run via `pnpm test` (node --test); needs `pnpm -r build` first (CI does this).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyRisk,
  decide,
  deriveProgress,
  routeReview,
} from "../packages/core/dist/index.js";

const LENSES = ["correctness", "security", "tests"];

test("review depth routes by change risk through the public surface", () => {
  // low → single reviewer, medium → lens subset, high → full panel.
  assert.deepEqual(routeReview(["README.md"], LENSES).lenses, []);
  assert.deepEqual(routeReview(["src/util.ts"], LENSES).lenses, [
    "correctness",
    "tests",
  ]);
  assert.deepEqual(routeReview(["src/auth.ts"], LENSES).lenses, LENSES);
  // no visible diff → conservative full panel.
  assert.deepEqual(routeReview([], LENSES).lenses, LENSES);
});

test("classifyRisk precedence holds (security outranks breadth)", () => {
  assert.equal(classifyRisk(["src/auth.ts", "db/1.sql"]).class, "security-sensitive");
  assert.equal(classifyRisk(["packages/a/x.ts", "apps/b/y.ts"]).class, "cross-module");
});

test("policy stops a run that produces no diff for consecutive iterations", () => {
  const obs = (sig, cost) => ({
    diffSignature: sig,
    failingChecks: null,
    failureSignature: null,
    findingSignatures: [],
    cumulativeCostUsd: cost,
  });
  // Two stalled iterations in a row → stop-low-progress.
  const signals = deriveProgress(obs("", 0.4), obs("", 0.2));
  assert.equal(
    decide(signals, { stalledIterations: 2, repeatedFailureStreak: 0, failingChecks: null })
      .action,
    "stop-low-progress"
  );
  // Still making progress → continue.
  assert.equal(
    decide(signals, { stalledIterations: 0, repeatedFailureStreak: 0, failingChecks: null })
      .action,
    "continue"
  );
});
