import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  evaluateExpectation,
  readBenchmarkSuite,
  runFixtureChecks,
  type BenchmarkCheck,
  type BenchmarkTask,
  type CheckResult,
} from "./bench.js";
import { compareTrajectories, scoreTrajectory } from "./eval.js";
import {
  listRunIds,
  readManifest as readManifestFs,
  readStageRecords as readStageRecordsFs,
  type RunManifest,
  type StageRecord,
} from "./run-report.js";

/** A named configuration overlay replayed against every benchmark task. */
export type EvalConfig = {
  /** Report column label (e.g. "baseline", "panel", "codex"). */
  label: string;
  /** Extra CLI flags layered on top of the task's own args. */
  args: string[];
  /** Env overrides layered on top of the task's own env. */
  env: Record<string, string>;
};

/** One concrete replay: a task under a config, resolved to a bin invocation. */
export type EvalInvocation = {
  task: BenchmarkTask;
  config: EvalConfig;
  /** Absolute fixture workspace dir the run executes in. */
  fixtureDir: string;
  /** Bin name to spawn (`otto-afk` / `otto-ghafk`). */
  bin: string;
  /** Planned iteration count. */
  iterations: number;
  /** Final argv passed to the bin (task args + config args). */
  args: string[];
  /** Env overrides merged for the run (task env + config env). */
  env: Record<string, string>;
};

/**
 * Drives one otto replay and reports the run id its evidence bundle was written
 * under. Injectable so {@link runEval} is unit-testable without spawning real,
 * paid model runs (the default spawns the bin and returns the fixture's latest
 * run id).
 */
export type EvalInvoker = (inv: EvalInvocation) => Promise<{ runId: string }>;

/** Injectable host surface for {@link runEval}. */
export type EvalDeps = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
  invoke: EvalInvoker;
  readManifest: (workspaceDir: string, runId: string) => RunManifest | null;
  readStageRecords: (workspaceDir: string, runId: string) => StageRecord[];
  runChecks: (checks: BenchmarkCheck[], cwd: string) => CheckResult[];
};

const defaultInvoke: EvalInvoker = async (inv) => {
  const argv =
    inv.bin === "otto-afk"
      ? [inv.task.inputs, String(inv.iterations), ...inv.args]
      : [String(inv.iterations), ...inv.args];
  await new Promise<void>((res, rej) => {
    const child = spawn(inv.bin, argv, {
      cwd: inv.fixtureDir,
      env: { ...process.env, ...inv.env },
      stdio: "inherit",
    });
    child.on("error", rej);
    child.on("close", () => res());
  });
  const ids = listRunIds(inv.fixtureDir);
  return { runId: ids[ids.length - 1] ?? "" };
};

const defaultDeps: EvalDeps = {
  env: process.env,
  cwd: process.cwd(),
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
  invoke: defaultInvoke,
  readManifest: readManifestFs,
  readStageRecords: readStageRecordsFs,
  runChecks: runFixtureChecks,
};

const USAGE =
  "Usage: otto-eval <suite.json> [<configs.json>] [--iterations <n>]";

/**
 * Validate a raw eval-config matrix (array of `{label, args?, env?}`). Throws on
 * a non-array or a config missing its label. Pure.
 */
export function parseEvalConfigs(raw: unknown): EvalConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error("eval configs: expected an array of {label, args?, env?}");
  }
  return raw.map((c, i) => {
    if (c == null || typeof c !== "object" || Array.isArray(c)) {
      throw new Error(`eval config [${i}]: expected an object`);
    }
    const rec = c as Record<string, unknown>;
    if (typeof rec.label !== "string" || rec.label.length === 0) {
      throw new Error(`eval config [${i}]: 'label' must be a non-empty string`);
    }
    const args = rec.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
      throw new Error(`eval config '${rec.label}': 'args' must be an array of strings`);
    }
    const env = rec.env;
    if (env !== undefined && (env == null || typeof env !== "object" || Array.isArray(env))) {
      throw new Error(`eval config '${rec.label}': 'env' must be an object`);
    }
    return {
      label: rec.label,
      args: (args as string[]) ?? [],
      env: (env as Record<string, string>) ?? {},
    };
  });
}

type ParsedArgs = {
  suitePath?: string;
  configsPath?: string;
  iterations: number;
  help: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { iterations: 3, help: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") parsed.help = true;
    else if (a === "--iterations") parsed.iterations = Number(argv[++i]);
    else positionals.push(a);
  }
  parsed.suitePath = positionals[0];
  parsed.configsPath = positionals[1];
  return parsed;
}

/**
 * Drive the `otto-eval` command: load a benchmark suite and a config matrix,
 * replay every task under every config (via the injectable invoker — this is the
 * paid, model-dependent half of the eval suite, never run in CI), score each
 * run's evidence bundle, run its fixture checks, and print a per-task comparison
 * table plus a PASS/FAIL verdict per config. Resolves to a process exit code:
 * `0` when every expectation held, `1` otherwise.
 */
export async function runEval(
  argv: string[],
  deps: EvalDeps = defaultDeps
): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    deps.out(USAGE);
    return 0;
  }
  if (!args.suitePath) {
    deps.err(`No benchmark suite given.\n${USAGE}`);
    return 1;
  }

  const suitePath = resolve(deps.cwd, args.suitePath);
  let tasks: BenchmarkTask[];
  try {
    tasks = readBenchmarkSuite(suitePath);
  } catch (e) {
    deps.err((e as Error).message);
    return 1;
  }

  let configs: EvalConfig[] = [{ label: "default", args: [], env: {} }];
  if (args.configsPath) {
    try {
      configs = parseEvalConfigs(
        JSON.parse(readFileSync(resolve(deps.cwd, args.configsPath), "utf8"))
      );
    } catch (e) {
      deps.err(`eval configs ${args.configsPath}: ${(e as Error).message}`);
      return 1;
    }
  }

  const suiteDir = dirname(suitePath);
  let allPassed = true;

  for (const task of tasks) {
    const fixtureDir = resolve(suiteDir, task.fixture);
    const labelled: { label: string; signals: ReturnType<typeof scoreTrajectory> }[] = [];
    const verdictLines: string[] = [];

    for (const config of configs) {
      const inv: EvalInvocation = {
        task,
        config,
        fixtureDir,
        bin: task.bin,
        iterations: args.iterations,
        args: [...task.args, ...config.args],
        env: { ...task.env, ...config.env },
      };
      const { runId } = await deps.invoke(inv);
      const manifest = deps.readManifest(fixtureDir, runId);
      if (!manifest) {
        allPassed = false;
        verdictLines.push(`  - ${config.label}: FAIL (no evidence bundle for run '${runId}')`);
        continue;
      }
      const signals = scoreTrajectory(manifest, deps.readStageRecords(fixtureDir, runId));
      const checks = deps.runChecks(task.expect.checks ?? [], fixtureDir);
      const verdict = evaluateExpectation(task.expect, signals, checks);
      if (!verdict.passed) allPassed = false;
      labelled.push({ label: config.label, signals });
      verdictLines.push(
        verdict.passed
          ? `  - ${config.label}: PASS`
          : `  - ${config.label}: FAIL (${verdict.failures.join("; ")})`
      );
    }

    deps.out(`## ${task.id} (${task.kind})`);
    deps.out("");
    deps.out(compareTrajectories(labelled));
    deps.out("");
    deps.out("Verdicts:");
    for (const line of verdictLines) deps.out(line);
    deps.out("");
  }

  return allPassed ? 0 : 1;
}
