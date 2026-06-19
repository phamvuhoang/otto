import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateRunId,
  listRunIds,
  readManifest,
  readStageRecords,
  runReportDir,
  runsDir,
  writeManifest,
  writeStageRecord,
  type RunManifest,
  type SafetyEvent,
  type StageRecord,
} from "../run-report.js";
import { emptyTokenUsage } from "../tokens.js";

const safetyEvents: SafetyEvent[] = [
  {
    category: "policy-violation",
    kind: "blocked-command",
    subject: "rm -rf /",
    message: 'command matches blocked pattern "rm -rf"',
    blocked: true,
  },
  {
    category: "taint",
    kind: "issue-body",
    subject: "issue #43 body",
    message: "untrusted issue body surfaced",
    blocked: false,
  },
];

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-run-report-"));
}

const manifest: RunManifest = {
  runId: "2026-06-19T00-00-00-000Z-13793",
  bin: "otto-ghafk",
  mode: "ghafk",
  inputs: "39",
  runtime: { id: "claude", displayName: "Claude Code" },
  branchStrategy: "branch",
  iterations: 5,
  costUsd: 0,
  tokenUsage: emptyTokenUsage(),
  artifacts: [],
  startedAt: "2026-06-19T00:00:00.000Z",
};

const stageRecord: StageRecord = {
  iteration: 1,
  stage: "implementer",
  runtimeId: "claude",
  costUsd: 0.42,
  usage: emptyTokenUsage(),
  isError: false,
  apiErrorStatus: null,
  logPath: ".otto-tmp/logs/x-iter1-implementer-claude.ndjson",
  startedAt: "2026-06-19T00:00:00.000Z",
  finishedAt: "2026-06-19T00:01:00.000Z",
};

describe("allocateRunId", () => {
  it("is sortable, filesystem-safe, and pid-suffixed", () => {
    const id = allocateRunId(new Date("2026-06-19T12:34:56.789Z"), 4242);
    expect(id).toBe("2026-06-19T12-34-56-789Z-4242");
    // No characters that are unsafe in a path segment.
    expect(id).not.toMatch(/[:.]/);
  });
  it("sorts chronologically as a plain string", () => {
    const a = allocateRunId(new Date("2026-06-19T00:00:00.000Z"), 1);
    const b = allocateRunId(new Date("2026-06-19T00:00:01.000Z"), 1);
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe("path helpers", () => {
  it("compose the bundle dir under .otto/runs/<run-id>", () => {
    expect(runsDir("/ws")).toBe(join("/ws", ".otto", "runs"));
    expect(runReportDir("/ws", "rid")).toBe(
      join("/ws", ".otto", "runs", "rid")
    );
  });
});

describe("manifest I/O", () => {
  it("round-trips a write", () => {
    const d = tmp();
    writeManifest(d, manifest);
    expect(
      existsSync(join(d, ".otto", "runs", manifest.runId, "manifest.json"))
    ).toBe(true);
    expect(readManifest(d, manifest.runId)).toEqual(manifest);
  });
  it("round-trips safety events recorded on the manifest", () => {
    const d = tmp();
    const m = { ...manifest, safetyEvents };
    writeManifest(d, m);
    expect(readManifest(d, m.runId)).toEqual(m);
  });
  it("returns null when absent", () => {
    expect(readManifest(tmp(), "nope")).toBeNull();
  });
  it("returns null on malformed JSON", () => {
    const d = tmp();
    mkdirSync(join(d, ".otto", "runs", "rid"), { recursive: true });
    writeFileSync(join(d, ".otto", "runs", "rid", "manifest.json"), "{ nope");
    expect(readManifest(d, "rid")).toBeNull();
  });
});

describe("listRunIds", () => {
  it("lists run-id dirs sorted ascending (latest last)", () => {
    const d = tmp();
    writeManifest(d, { ...manifest, runId: "2026-06-19T09-00-00-000Z-1" });
    writeManifest(d, { ...manifest, runId: "2026-06-19T00-00-00-000Z-1" });
    expect(listRunIds(d)).toEqual([
      "2026-06-19T00-00-00-000Z-1",
      "2026-06-19T09-00-00-000Z-1",
    ]);
  });
  it("returns [] when .otto/runs is absent", () => {
    expect(listRunIds(tmp())).toEqual([]);
  });
});

describe("stage record I/O", () => {
  it("round-trips records in seq order", () => {
    const d = tmp();
    const rid = manifest.runId;
    writeStageRecord(d, rid, 0, stageRecord);
    writeStageRecord(d, rid, 1, {
      ...stageRecord,
      stage: "reviewer",
      finishedAt: "2026-06-19T00:02:00.000Z",
    });
    const got = readStageRecords(d, rid);
    expect(got.map((r) => r.stage)).toEqual(["implementer", "reviewer"]);
    expect(got[0]).toEqual(stageRecord);
  });
  it("sanitizes an unsafe stage name in the filename", () => {
    const d = tmp();
    const name = writeStageRecord(d, "rid", 0, {
      ...stageRecord,
      stage: "task fit/security",
    });
    expect(name).toMatch(/^0000-iter1-task-fit-security\.json$/);
    // The record itself preserves the original stage name.
    expect(readStageRecords(d, "rid")[0].stage).toBe("task fit/security");
  });
  it("round-trips safety events recorded on a stage record", () => {
    const d = tmp();
    writeStageRecord(d, "rid", 0, { ...stageRecord, safetyEvents });
    expect(readStageRecords(d, "rid")[0].safetyEvents).toEqual(safetyEvents);
  });
  it("returns [] when the run has no stage records", () => {
    expect(readStageRecords(tmp(), "nope")).toEqual([]);
  });
});
