import { describe, it, expect } from "vitest";
import { scoreTrajectory } from "../eval.js";
import type { RunManifest } from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";
import type { ChecksSummary } from "../attestation.js";

const manifest = (over: Partial<RunManifest>): RunManifest =>
  ({
    runId: "r1",
    bin: "otto-ghafk",
    mode: "ghafk",
    inputs: "",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 1,
    costUsd: 0,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
    exitReason: "complete",
    startedAt: "2026-07-31T00:00:00.000Z",
    finishedAt: "2026-07-31T00:02:00.000Z",
    ...over,
  }) as RunManifest;

const summary = (over: Partial<ChecksSummary>): ChecksSummary => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  failureSignatures: [],
  everFailed: false,
  terminalFailed: 0,
  ...over,
});

describe("eval succeeded incorporates attested checks", () => {
  it("disagreement fixture: exit-reason success + terminal red ⇒ succeeded false", () => {
    const s = scoreTrajectory(
      manifest({
        checksSummary: summary({
          failed: 1,
          terminalFailed: 1,
          everFailed: true,
        }),
      }),
      []
    );
    expect(s.exitReason).toBe("complete"); // exit reason alone still says success…
    expect(s.succeeded).toBe(false); // …but the attested truth wins.
    expect(s.attestedTerminalFailures).toBe(1);
  });

  it("recovery fixture: mid-run red, terminal green ⇒ succeeded true", () => {
    const s = scoreTrajectory(
      manifest({
        checksSummary: summary({
          passed: 2,
          failed: 1,
          everFailed: true,
          terminalFailed: 0,
        }),
      }),
      []
    );
    expect(s.succeeded).toBe(true); // the loop fixed it — that is a WIN
    expect(s.attestedTerminalFailures).toBe(0);
  });

  it("attested pass keeps succeeded true", () => {
    const s = scoreTrajectory(
      manifest({ checksSummary: summary({ passed: 2 }) }),
      []
    );
    expect(s.succeeded).toBe(true);
  });

  it("inert fixture: no checksSummary ⇒ unchanged behavior", () => {
    const s = scoreTrajectory(manifest({}), []);
    expect(s.succeeded).toBe(true);
    expect(s.attestedTerminalFailures).toBe(0);
  });

  it("a failing exit reason stays failing regardless of green checks", () => {
    const s = scoreTrajectory(
      manifest({
        exitReason: "stopped (budget)",
        checksSummary: summary({ passed: 2 }),
      }),
      []
    );
    expect(s.succeeded).toBe(false);
  });

  it("a non-success reason with terminal red is sunk by the guard, not the override", () => {
    // The exit-reason override only replaces SUCCESS reasons, so this run keeps
    // "stopped (budget)". The terminalFailed guard is the only thing making
    // succeeded false here — which is exactly why it is not dead code.
    const s = scoreTrajectory(
      manifest({
        exitReason: "stopped (budget)",
        checksSummary: summary({ failed: 1, terminalFailed: 1 }),
      }),
      []
    );
    expect(s.succeeded).toBe(false);
    expect(s.attestedTerminalFailures).toBe(1);
  });
});
