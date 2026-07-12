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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseVerificationMatrix,
  scoreVerificationCoverage,
  validateVerificationEvidence,
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

test("evidence validation runs against a real workspace — existence and produced-this-run gate coverage (issue #202)", () => {
  // The anti-fabrication layer itself, not just gate plumbing: a real temp
  // workspace where one cited artifact exists, one is fabricated, and one is a
  // scratch leftover from a "previous run" (mtime before the run start).
  const ws = mkdtempSync(join(tmpdir(), "otto-eval-verify-"));
  try {
    writeFileSync(join(ws, "impl.ts"), "line1\nline2\n");
    mkdirSync(join(ws, ".otto-tmp"), { recursive: true });
    const stale = join(ws, ".otto-tmp", "old-shot.png");
    writeFileSync(stale, "png-bytes");
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(stale, hourAgo, hourAgo);

    const row = (requirement, artifactPath) => ({
      requirement,
      method: "inspection",
      check: "read the code",
      artifactPath,
      result: "pass",
      confidence: "high",
    });
    const out = validateVerificationEvidence(
      [
        row("real file:line evidence", "impl.ts:2"),
        row("fabricated path", "proof/does-not-exist.png"),
        row("stale prior-run screenshot", ".otto-tmp/old-shot.png"),
      ],
      {
        workspaceDir: ws,
        runId: "eval",
        startedAtMs: Date.now() - 1_000,
        commitExists: () => false,
      }
    );
    assert.equal(out[0].artifactExists, true, "existing file:line counts");
    assert.equal(out[1].artifactExists, false, "fabricated path rejected");
    assert.equal(out[2].artifactExists, false, "stale scratch rejected");
    assert.equal(out[2].artifactBundled, false, "stale scratch not bundled");

    const gate = scoreVerificationCoverage(out);
    assert.equal(gate.passed, false);
    assert.ok(gate.unproven.includes("fabricated path"));
    assert.ok(gate.unproven.includes("stale prior-run screenshot"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
