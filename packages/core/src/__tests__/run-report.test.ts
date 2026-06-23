import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateRunId,
  hasRunReport,
  listRunIds,
  readManifest,
  readRunReport,
  readStageRecords,
  runReportDir,
  runsDir,
  writeManifest,
  writeRunReport,
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

describe("run report persistence (P9 #64)", () => {
  const REPORT = "# Otto quality report\n\n## Verdict\n\nNeeds human review\n";

  it("round-trips a written report", () => {
    const d = tmp();
    writeRunReport(d, manifest.runId, REPORT);
    expect(readRunReport(d, manifest.runId)).toBe(REPORT);
  });

  it("ensures a trailing newline", () => {
    const d = tmp();
    writeRunReport(d, manifest.runId, "# Otto quality report");
    expect(readRunReport(d, manifest.runId)).toBe("# Otto quality report\n");
  });

  it("reads null for an absent report (never throws)", () => {
    expect(readRunReport(tmp(), "no-such-run")).toBeNull();
  });

  it("hasRunReport keys on the report H1 marker, not the stage name", () => {
    expect(hasRunReport("blah\n# Otto quality report\n## Verdict")).toBe(true);
    expect(hasRunReport("<review>OK</review>")).toBe(false);
    expect(hasRunReport("")).toBe(false);
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
  it("round-trips a context breakdown recorded on a stage record", () => {
    const d = tmp();
    const contextBreakdown = {
      totalChars: 100,
      estimatedTokens: 25,
      segments: [
        { category: "playbook" as const, chars: 60, estimatedTokens: 15 },
        { category: "learnings" as const, chars: 40, estimatedTokens: 10 },
      ],
    };
    writeStageRecord(d, "rid", 0, { ...stageRecord, contextBreakdown });
    expect(readStageRecords(d, "rid")[0].contextBreakdown).toEqual(
      contextBreakdown
    );
  });
  it("round-trips skills used recorded on a stage record", () => {
    const d = tmp();
    const skillsUsed = [{ name: "release-flow", version: "1.0.0", reasons: ["scope match"] }];
    writeStageRecord(d, "rid", 0, { ...stageRecord, skillsUsed });
    expect(readStageRecords(d, "rid")[0].skillsUsed).toEqual(skillsUsed);
  });
  it("round-trips reviewSeverity counts recorded on a stage record", () => {
    const d = tmp();
    const reviewSeverity = { blocker: 1, major: 0, minor: 0, nit: 2, suppressed: 2 };
    writeStageRecord(d, "rid", 0, { ...stageRecord, reviewSeverity });
    expect(readStageRecords(d, "rid")[0].reviewSeverity).toEqual(reviewSeverity);
  });
  it("returns [] when the run has no stage records", () => {
    expect(readStageRecords(tmp(), "nope")).toEqual([]);
  });
});
