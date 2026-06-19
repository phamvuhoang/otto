import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseBenchmarkSuite,
  parseBenchmarkTask,
  readBenchmarkSuite,
} from "../bench.js";

const minimal = {
  id: "bug-fix",
  kind: "bug-fix",
  fixture: "fixtures/bug-fix",
  bin: "otto-afk",
  inputs: "fix the failing test",
};

describe("parseBenchmarkTask", () => {
  it("parses a minimal task and fills defaults", () => {
    const task = parseBenchmarkTask(minimal);
    expect(task.id).toBe("bug-fix");
    expect(task.kind).toBe("bug-fix");
    expect(task.fixture).toBe("fixtures/bug-fix");
    expect(task.bin).toBe("otto-afk");
    expect(task.inputs).toBe("fix the failing test");
    expect(task.args).toEqual([]);
    expect(task.env).toEqual({});
    expect(task.expect).toEqual({});
  });

  it("parses a full task with args, env, and expectations", () => {
    const task = parseBenchmarkTask({
      ...minimal,
      args: ["--review-panel"],
      env: { OTTO_RUNNER: "host" },
      expect: {
        succeeded: true,
        maxCostUsd: 1.5,
        checks: [{ name: "tests", command: "pnpm test" }],
      },
    });
    expect(task.args).toEqual(["--review-panel"]);
    expect(task.env).toEqual({ OTTO_RUNNER: "host" });
    expect(task.expect.succeeded).toBe(true);
    expect(task.expect.maxCostUsd).toBe(1.5);
    expect(task.expect.checks).toEqual([{ name: "tests", command: "pnpm test" }]);
  });

  it("rejects a non-object", () => {
    expect(() => parseBenchmarkTask(null)).toThrow(/benchmark task/);
    expect(() => parseBenchmarkTask("nope")).toThrow(/benchmark task/);
  });

  it("rejects a missing or empty required string field", () => {
    expect(() => parseBenchmarkTask({ ...minimal, id: "" })).toThrow(/id/);
    expect(() => parseBenchmarkTask({ ...minimal, fixture: undefined })).toThrow(
      /fixture/
    );
  });

  it("rejects an unknown bin", () => {
    expect(() => parseBenchmarkTask({ ...minimal, bin: "otto-nope" })).toThrow(
      /bin/
    );
  });

  it("rejects a malformed check entry", () => {
    expect(() =>
      parseBenchmarkTask({ ...minimal, expect: { checks: [{ name: "x" }] } })
    ).toThrow(/check/);
  });

  it("rejects a non-numeric maxCostUsd", () => {
    expect(() =>
      parseBenchmarkTask({ ...minimal, expect: { maxCostUsd: "lots" } })
    ).toThrow(/maxCostUsd/);
  });
});

describe("parseBenchmarkSuite", () => {
  it("parses an array of tasks", () => {
    const tasks = parseBenchmarkSuite([minimal, { ...minimal, id: "feature" }]);
    expect(tasks.map((t) => t.id)).toEqual(["bug-fix", "feature"]);
  });

  it("rejects a non-array", () => {
    expect(() => parseBenchmarkSuite({})).toThrow(/array/);
  });

  it("rejects duplicate task ids", () => {
    expect(() => parseBenchmarkSuite([minimal, minimal])).toThrow(/duplicate/);
  });
});

describe("readBenchmarkSuite", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otto-bench-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and parses a suite file", () => {
    const path = join(dir, "suite.json");
    writeFileSync(path, JSON.stringify([minimal]));
    const tasks = readBenchmarkSuite(path);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("bug-fix");
  });

  it("throws a path-qualified error for malformed JSON", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json");
    expect(() => readBenchmarkSuite(path)).toThrow(/broken\.json/);
  });
});
