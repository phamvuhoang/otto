// Deterministic (no-model) CI subset of the harness evaluation suite (issue #40,
// plan task 7). The paid half — actually replaying fixtures with otto-eval — is
// never run in CI. What IS safe to run on every push, and what this pins:
//   1. benchmarks/suite.json parses and every fixture dir it names exists.
//   2. The pure scoring substrate (scoreTrajectory / compareTrajectories /
//      evaluateExpectation) behaves, exercised through the published package.
//   3. The no-model fixture subset: the safety fixture's deterministic check
//      passes on the clean tree, and a code fixture's check fails on the
//      unfixed tree (proving the benchmark actually has signal).
// So every roadmap initiative can add a benchmark and have it structurally
// validated before shipping. Run via `pnpm test` (node --test); needs
// `pnpm -r build` first (CI does this), since it imports the built package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  compareTrajectories,
  evaluateExpectation,
  parseEvalConfigs,
  readBenchmarkSuite,
  runFixtureChecks,
  scoreTrajectory,
} from "../packages/core/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const suitePath = join(root, "benchmarks", "suite.json");
const suiteDir = dirname(suitePath);

const tasks = readBenchmarkSuite(suitePath);

test("suite manifest parses and every fixture directory exists", () => {
  assert.ok(tasks.length > 0, "expected at least one benchmark task");
  for (const t of tasks) {
    const fixtureDir = resolve(suiteDir, t.fixture);
    assert.ok(
      existsSync(fixtureDir),
      `fixture for '${t.id}' missing: ${fixtureDir}`
    );
  }
});

test("every task names a known bin and a deterministic expectation", () => {
  for (const t of tasks) {
    assert.ok(["otto-afk", "otto-ghafk"].includes(t.bin), `${t.id}: bin`);
    // Each task asserts something we can score deterministically.
    const hasExpectation =
      t.expect.succeeded !== undefined ||
      t.expect.maxCostUsd !== undefined ||
      (t.expect.checks?.length ?? 0) > 0;
    assert.ok(hasExpectation, `${t.id}: empty expectation has no signal`);
  }
});

test("scoring substrate derives signals, compares, and verdicts", () => {
  const manifest = {
    runId: "2026-06-19T00-00-00-000Z-1",
    bin: "otto-afk",
    mode: "afk",
    inputs: "",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 1,
    completedIterations: 1,
    costUsd: 0.4,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    exitReason: "complete",
    startedAt: "2026-06-19T00:00:00.000Z",
    finishedAt: "2026-06-19T00:00:08.000Z",
    artifacts: [],
  };
  const signals = scoreTrajectory(manifest, []);
  assert.equal(signals.succeeded, true);
  assert.equal(signals.totalTokens, 15);
  assert.equal(signals.elapsedMs, 8000);

  const table = compareTrajectories([
    { label: "a", signals },
    { label: "b", signals: { ...signals, costUsd: 0.9 } },
  ]);
  assert.match(table, /\| Run \|/);
  assert.match(table, /\$0.4 \(best\)/);

  const verdict = evaluateExpectation(
    { succeeded: true, maxCostUsd: 0.5 },
    signals,
    [{ name: "tests", passed: true }]
  );
  assert.equal(verdict.passed, true);
});

test("the config matrix parses and includes an adaptive-router on/off pair", () => {
  const configs = parseEvalConfigs(
    JSON.parse(readFileSync(join(suiteDir, "configs.json"), "utf8"))
  );
  const labels = configs.map((c) => c.label);
  // baseline = router off; adaptive = router on. Both present → the eval suite
  // can A/B the adaptive compute router (#41) deterministically.
  assert.ok(labels.includes("baseline"), "configs.json missing the baseline (router-off) config");
  const adaptive = configs.find((c) => c.label === "adaptive");
  assert.ok(adaptive, "configs.json missing the adaptive (router-on) config");
  assert.ok(
    adaptive.args.includes("--adaptive-router"),
    "the adaptive config must pass --adaptive-router"
  );
});

test("the safety fixture's no-model check passes on the clean tree", () => {
  const safety = tasks.find((t) => t.id === "prompt-injection");
  assert.ok(safety, "prompt-injection task missing");
  const results = runFixtureChecks(
    safety.expect.checks ?? [],
    resolve(suiteDir, safety.fixture)
  );
  assert.deepEqual(results, [{ name: "no-pwned", passed: true }]);
});

test("a code fixture's check fails on the unfixed tree (the benchmark has signal)", () => {
  const bugFix = tasks.find((t) => t.id === "bug-fix");
  assert.ok(bugFix, "bug-fix task missing");
  // Custom runner with a clean env: this fixture's check is `node --test`, and a
  // child `node --test` no-ops (exit 0) when it inherits NODE_TEST_CONTEXT from
  // this parent runner. The paid suite runs via the otto-eval bin (not under
  // `node --test`), so the default runner is correct there; here we strip it so
  // the assertion measures the fixture, not the nesting quirk.
  const cleanRun = (command, cwd) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return { status: spawnSync(command, { shell: true, cwd, stdio: "ignore", env }).status };
  };
  const results = runFixtureChecks(
    bugFix.expect.checks ?? [],
    resolve(suiteDir, bugFix.fixture),
    cleanRun
  );
  assert.deepEqual(results, [{ name: "tests", passed: false }]);
});
