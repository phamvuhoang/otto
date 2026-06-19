import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type { EvalSignals } from "./eval.js";
import { resolveShell } from "./render.js";

/**
 * A deterministic outcome check run in the fixture workspace after a benchmark
 * replay completes. The command is run with `cwd` = the fixture; exit 0 = pass.
 * One general shape covers tests-passed (run the test cmd), diff-correctness
 * (assert a file/grep), and safety (assert an injected change is absent).
 */
export type BenchmarkCheck = {
  /** Stable name shown in the report (e.g. "tests", "no-injected-file"). */
  name: string;
  /** Shell command run in the fixture workspace; exit 0 = pass. */
  command: string;
};

/**
 * The deterministic expected outcome of a benchmark replay. Every field is
 * optional — an empty expectation asserts nothing. {@link BenchmarkCheck}s are
 * the fixture-derived checks scored in plan task 4; the rest are trajectory
 * signals scored from the evidence bundle.
 */
export type BenchmarkExpect = {
  /** Required terminal success signal (the `succeeded` eval signal). */
  succeeded?: boolean;
  /** Cost ceiling in USD the run must not exceed. */
  maxCostUsd?: number;
  /** Named command checks run in the fixture after the run. */
  checks?: BenchmarkCheck[];
};

/** The two otto bins a benchmark task can replay. */
export type BenchmarkBin = "otto-afk" | "otto-ghafk";

/**
 * One benchmark job: a fixture repo plus the otto bin/args/env to replay against
 * it and the deterministic expectations to score. Configuration variants (panel
 * on/off, token modes, runtimes) are layered on top by the runner (plan task 5);
 * this is the base task definition.
 */
export type BenchmarkTask = {
  /** Unique task id (also the report row label). */
  id: string;
  /** Coarse category (e.g. "bug-fix", "feature", "review-repair", "triage"). */
  kind: string;
  /** Fixture path, relative to the suite file. */
  fixture: string;
  /** Which otto bin to replay. */
  bin: BenchmarkBin;
  /** The plan/PRD string for otto-afk; "" for otto-ghafk. */
  inputs: string;
  /** Extra CLI flags passed to the bin. */
  args: string[];
  /** Env overrides applied to the replay. */
  env: Record<string, string>;
  /** Deterministic expected outcome. */
  expect: BenchmarkExpect;
};

const BINS: readonly BenchmarkBin[] = ["otto-afk", "otto-ghafk"];

function asRecord(raw: unknown, ctx: string): Record<string, unknown> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${ctx}: expected an object`);
  }
  return raw as Record<string, unknown>;
}

function requireString(rec: Record<string, unknown>, key: string, ctx: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${ctx}: '${key}' must be a non-empty string`);
  }
  return v;
}

function parseExpect(raw: unknown, ctx: string): BenchmarkExpect {
  if (raw === undefined) return {};
  const rec = asRecord(raw, `${ctx}.expect`);
  const expect: BenchmarkExpect = {};

  if (rec.succeeded !== undefined) {
    if (typeof rec.succeeded !== "boolean") {
      throw new Error(`${ctx}.expect: 'succeeded' must be a boolean`);
    }
    expect.succeeded = rec.succeeded;
  }
  if (rec.maxCostUsd !== undefined) {
    if (typeof rec.maxCostUsd !== "number" || Number.isNaN(rec.maxCostUsd)) {
      throw new Error(`${ctx}.expect: 'maxCostUsd' must be a number`);
    }
    expect.maxCostUsd = rec.maxCostUsd;
  }
  if (rec.checks !== undefined) {
    if (!Array.isArray(rec.checks)) {
      throw new Error(`${ctx}.expect: 'checks' must be an array`);
    }
    expect.checks = rec.checks.map((c, i) => {
      const cr = asRecord(c, `${ctx}.expect.checks[${i}]`);
      return {
        name: requireString(cr, "name", `${ctx}.expect.checks[${i}]`),
        command: requireString(cr, "command", `${ctx}.expect.checks[${i}]`),
      };
    });
  }
  return expect;
}

/**
 * Validate and normalize one raw benchmark task, filling defaults for the
 * optional fields. Pure: throws a descriptive {@link Error} on any schema
 * violation, never reads I/O.
 */
export function parseBenchmarkTask(raw: unknown): BenchmarkTask {
  const ctx = "benchmark task";
  const rec = asRecord(raw, ctx);
  const id = requireString(rec, "id", ctx);
  const taskCtx = `benchmark task '${id}'`;

  const bin = requireString(rec, "bin", taskCtx);
  if (!BINS.includes(bin as BenchmarkBin)) {
    throw new Error(`${taskCtx}: 'bin' must be one of ${BINS.join(", ")}`);
  }

  let args: string[] = [];
  if (rec.args !== undefined) {
    if (!Array.isArray(rec.args) || rec.args.some((a) => typeof a !== "string")) {
      throw new Error(`${taskCtx}: 'args' must be an array of strings`);
    }
    args = rec.args as string[];
  }

  let env: Record<string, string> = {};
  if (rec.env !== undefined) {
    const er = asRecord(rec.env, `${taskCtx}.env`);
    for (const [k, v] of Object.entries(er)) {
      if (typeof v !== "string") {
        throw new Error(`${taskCtx}.env: '${k}' must be a string`);
      }
    }
    env = er as Record<string, string>;
  }

  return {
    id,
    kind: requireString(rec, "kind", taskCtx),
    fixture: requireString(rec, "fixture", taskCtx),
    bin: bin as BenchmarkBin,
    // `inputs` is required but may legitimately be "" (ghafk); only reject non-strings.
    inputs: requireInputs(rec.inputs, taskCtx),
    args,
    env,
    expect: parseExpect(rec.expect, taskCtx),
  };
}

function requireInputs(inputs: unknown, ctx: string): string {
  if (typeof inputs !== "string") {
    throw new Error(`${ctx}: 'inputs' must be a string`);
  }
  return inputs;
}

/**
 * Validate and normalize a raw benchmark suite (array of tasks). Throws on a
 * non-array, any invalid task, or a duplicate task id. Pure.
 */
export function parseBenchmarkSuite(raw: unknown): BenchmarkTask[] {
  if (!Array.isArray(raw)) {
    throw new Error("benchmark suite: expected an array of tasks");
  }
  const tasks = raw.map(parseBenchmarkTask);
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) {
      throw new Error(`benchmark suite: duplicate task id '${t.id}'`);
    }
    seen.add(t.id);
  }
  return tasks;
}

/** Pass/fail outcome of one {@link BenchmarkCheck}. */
export type CheckResult = { name: string; passed: boolean };

/**
 * Runs a check command in the fixture workspace and reports its exit status.
 * Injectable so {@link runFixtureChecks} stays unit-testable without spawning.
 */
export type CheckRunner = (
  command: string,
  cwd: string
) => { status: number | null };

const defaultCheckRunner: CheckRunner = (command, cwd) => {
  const r = spawnSync(command, { shell: resolveShell(), cwd, stdio: "ignore" });
  return { status: r.status };
};

/**
 * Run each fixture check command in `cwd` (the fixture workspace) and report
 * pass/fail per check — the fixture-derived signals (tests-passed,
 * diff-correctness, safety assertions) that the trajectory alone cannot give.
 * A check passes iff its command exits 0; a null status (signal-killed or a
 * spawn failure) is a failure.
 */
export function runFixtureChecks(
  checks: BenchmarkCheck[],
  cwd: string,
  run: CheckRunner = defaultCheckRunner
): CheckResult[] {
  return checks.map((c) => ({
    name: c.name,
    passed: run(c.command, cwd).status === 0,
  }));
}

/** Verdict of scoring one run against its benchmark expectation. */
export type ExpectationVerdict = {
  /** True iff every asserted expectation held. */
  passed: boolean;
  /** Human-readable reasons the run fell short (empty when passed). */
  failures: string[];
};

/**
 * Score the trajectory signals and fixture-check results of one replay against
 * its {@link BenchmarkExpect}. Pure: only the asserted fields are checked, so an
 * empty expectation always passes. Every shortfall is accumulated so a report
 * can show all of them at once.
 */
export function evaluateExpectation(
  expect: BenchmarkExpect,
  signals: EvalSignals,
  checks: CheckResult[]
): ExpectationVerdict {
  const failures: string[] = [];

  if (expect.succeeded !== undefined && signals.succeeded !== expect.succeeded) {
    failures.push(
      `succeeded: expected ${expect.succeeded}, got ${signals.succeeded}` +
        (signals.exitReason ? ` (exit: ${signals.exitReason})` : "")
    );
  }
  if (expect.maxCostUsd !== undefined && signals.costUsd > expect.maxCostUsd) {
    failures.push(
      `cost: $${signals.costUsd} exceeds ceiling $${expect.maxCostUsd}`
    );
  }
  for (const c of checks) {
    if (!c.passed) failures.push(`check '${c.name}' failed`);
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Read and parse a benchmark suite JSON file. Errors (missing file, malformed
 * JSON, schema violation) are re-thrown qualified with the file path.
 */
export function readBenchmarkSuite(path: string): BenchmarkTask[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`benchmark suite ${path}: cannot read (${(e as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`benchmark suite ${path}: invalid JSON (${(e as Error).message})`);
  }
  return parseBenchmarkSuite(raw);
}
