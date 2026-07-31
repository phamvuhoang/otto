import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { formatRunReport } from "../inspect.js";
import {
  readManifest,
  readStageRecords,
  writeManifest,
  writeStageRecord,
  type RunManifest,
  type StageRecord,
} from "../run-report.js";
import type { ChecksRecord } from "../checks.js";
import type { ChecksSummary } from "../attestation.js";
import { emptyTokenUsage } from "../tokens.js";

const CHECK: ChecksRecord = {
  command: "pnpm -r test",
  exitCode: 1,
  durationMs: 8123,
  outputTail: "FAIL src/b.test.ts > adds\n",
  failureSignature: "FAIL src/b.test.ts > adds",
  attestedAt: "2026-07-31T00:01:00.000Z",
};

const stage = (over: Partial<StageRecord>): StageRecord => ({
  iteration: 1,
  stage: "reviewer",
  runtimeId: "claude",
  costUsd: 0.1,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  startedAt: "2026-07-31T00:00:00.000Z",
  finishedAt: "2026-07-31T00:01:00.000Z",
  ...over,
});

const manifest = (over: Partial<RunManifest>): RunManifest =>
  ({
    runId: "r1",
    bin: "otto-ghafk",
    mode: "ghafk",
    inputs: "",
    runtime: { id: "claude", displayName: "Claude Code" },
    iterations: 1,
    costUsd: 0.1,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
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

describe("checks evidence round-trip", () => {
  it("persists StageRecord.checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-ev-"));
    writeStageRecord(dir, "r1", 0, stage({ checks: [CHECK] }));
    expect(readStageRecords(dir, "r1")[0].checks).toEqual([CHECK]);
  });

  it("persists RunManifest.checksSummary", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-ev-"));
    const s = summary({
      passed: 1,
      failed: 1,
      skipped: 1,
      failureSignatures: ["FAIL src/b.test.ts > adds"],
      everFailed: true,
      terminalFailed: 1,
    });
    writeManifest(dir, manifest({ checksSummary: s }));
    expect(readManifest(dir, "r1")!.checksSummary).toEqual(s);
  });

  it("omits both fields on an inert run", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-ev-"));
    writeStageRecord(dir, "r1", 0, stage({}));
    writeManifest(dir, manifest({}));
    expect(readStageRecords(dir, "r1")[0].checks).toBeUndefined();
    expect(readManifest(dir, "r1")!.checksSummary).toBeUndefined();
  });
});

describe("formatRunReport renders attested checks", () => {
  it("renders the manifest tally and the per-stage lines", () => {
    const out = formatRunReport(
      manifest({
        checksSummary: summary({
          passed: 1,
          failed: 1,
          skipped: 1,
          failureSignatures: ["FAIL src/b.test.ts > adds"],
          everFailed: true,
          terminalFailed: 1,
        }),
      }),
      [stage({ checks: [CHECK] })]
    );
    expect(out).toContain("1 passed, 1 failed, 1 skipped (harness-attested)");
    expect(out).toContain("FINAL STATE RED");
    expect(out).toContain("check: FAIL `pnpm -r test` (exit 1, 8123ms)");
  });

  it("marks a recovered run rather than calling it red", () => {
    const out = formatRunReport(
      manifest({
        checksSummary: summary({
          passed: 2,
          failed: 1,
          everFailed: true,
          terminalFailed: 0,
        }),
      }),
      [stage({})]
    );
    expect(out).toContain("recovered");
    expect(out).not.toContain("FINAL STATE RED");
  });

  it("renders nothing extra for an inert run", () => {
    const out = formatRunReport(manifest({}), [stage({})]);
    expect(out).not.toContain("harness-attested");
    expect(out).not.toContain("check:");
  });
});
