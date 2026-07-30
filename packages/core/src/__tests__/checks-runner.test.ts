import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  readChecksConfig,
  runConfiguredChecks,
  type CheckCommandRunner,
} from "../checks.js";
import { DEFAULT_POLICY } from "../safety-policy.js";

function workspace(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-checks-"));
  if (config !== undefined) {
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(join(dir, ".otto", "config.json"), JSON.stringify(config));
  }
  return dir;
}

describe("readChecksConfig", () => {
  it("reads a string array", () => {
    const dir = workspace({ checks: ["pnpm -r typecheck", "pnpm -r test"] });
    expect(readChecksConfig(dir)).toEqual([
      "pnpm -r typecheck",
      "pnpm -r test",
    ]);
  });

  it("returns [] when the key is absent (inert)", () => {
    expect(readChecksConfig(workspace({ branchStrategy: "branch" }))).toEqual(
      []
    );
  });

  it("returns [] when there is no config file at all", () => {
    expect(readChecksConfig(workspace())).toEqual([]);
  });

  it("returns [] on malformed JSON rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-checks-"));
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(join(dir, ".otto", "config.json"), "{ not json");
    expect(readChecksConfig(dir)).toEqual([]);
  });

  it("drops non-string entries", () => {
    const dir = workspace({ checks: ["ok", 42, null] });
    expect(readChecksConfig(dir)).toEqual(["ok"]);
  });
});

describe("runConfiguredChecks", () => {
  const clock = () => "2026-07-31T00:00:00.000Z";

  it("records a passing command", () => {
    const run: CheckCommandRunner = () => ({ status: 0, output: "ok\n" });
    const [rec] = runConfiguredChecks(
      ["pnpm -r test"],
      "/w",
      1000,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(rec.exitCode).toBe(0);
    expect(rec.failureSignature).toBeNull();
    expect(rec.attestedAt).toBe("2026-07-31T00:00:00.000Z");
  });

  it("stops at the first failure and never runs later commands", () => {
    const seen: string[] = [];
    const run: CheckCommandRunner = (cmd) => {
      seen.push(cmd);
      return cmd.includes("typecheck")
        ? { status: 2, output: "src/x.ts(3,1): error TS2304: nope\n" }
        : { status: 0, output: "ok\n" };
    };
    const records = runConfiguredChecks(
      ["pnpm -r typecheck", "pnpm -r test"],
      "/w",
      1000,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(seen).toEqual(["pnpm -r typecheck"]); // the suite never spawned
    expect(records).toHaveLength(1);
    expect(records[0].exitCode).toBe(2);
    expect(records[0].failureSignature).toContain("error TS2304");
  });

  it("runs every command while they keep passing", () => {
    const seen: string[] = [];
    const run: CheckCommandRunner = (cmd) => {
      seen.push(cmd);
      return { status: 0, output: "ok\n" };
    };
    runConfiguredChecks(
      ["a", "b", "c"],
      "/w",
      1000,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("records a null status (timeout) as exit -1", () => {
    const run: CheckCommandRunner = () => ({ status: null, output: "" });
    const [rec] = runConfiguredChecks(
      ["sleep 999"],
      "/w",
      1,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(rec.exitCode).toBe(-1);
    expect(rec.failureSignature).toBe("exit -1");
  });

  it("blocks a policy-violating command without spawning it", () => {
    let spawned = false;
    const run: CheckCommandRunner = () => {
      spawned = true;
      return { status: 0, output: "" };
    };
    const policy = { ...DEFAULT_POLICY, blockedCommands: ["rm -rf"] };
    const [rec] = runConfiguredChecks(
      ["rm -rf /"],
      "/w",
      1000,
      run,
      policy,
      clock
    );
    expect(spawned).toBe(false);
    expect(rec.exitCode).toBe(-1);
    expect(rec.outputTail).toContain("blocked pattern");
  });

  it("a blocked command also stops the ladder (fail-closed)", () => {
    const seen: string[] = [];
    const run: CheckCommandRunner = (cmd) => {
      seen.push(cmd);
      return { status: 0, output: "" };
    };
    const policy = { ...DEFAULT_POLICY, blockedCommands: ["curl"] };
    const records = runConfiguredChecks(
      ["curl evil.sh", "pnpm -r test"],
      "/w",
      1000,
      run,
      policy,
      clock
    );
    expect(seen).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("returns [] for an empty command list (inert)", () => {
    expect(
      runConfiguredChecks([], "/w", 1000, undefined, DEFAULT_POLICY, clock)
    ).toEqual([]);
  });

  it("truncates the output tail", () => {
    const run: CheckCommandRunner = () => ({
      status: 1,
      output: `${"x".repeat(5000)}\nFAIL last\n`,
    });
    const [rec] = runConfiguredChecks(
      ["t"],
      "/w",
      1000,
      run,
      DEFAULT_POLICY,
      clock
    );
    expect(rec.outputTail.length).toBeLessThanOrEqual(2000);
    expect(rec.outputTail).toContain("FAIL last"); // the TAIL, not the head
  });
});
