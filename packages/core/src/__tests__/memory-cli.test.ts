import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatAuditReport, runMemory } from "../memory-cli.js";
import { writeMemoryRecord, type MemoryRecord } from "../memory.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-memory-cli-"));
}

function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    content: "a learning",
    scope: [],
    confidence: 0.5,
    trust: "unverified",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    useCount: 0,
    ...over,
  };
}

describe("formatAuditReport", () => {
  it("renders the count breakdown and empty sections", () => {
    const out = formatAuditReport({
      stale: [],
      conflicting: [],
      frequentlyUsed: [],
      counts: {
        total: 0,
        active: 0,
        stale: 0,
        superseded: 0,
        conflicting: 0,
        frequentlyUsed: 0,
      },
    });
    expect(out).toContain("total:");
    expect(out).toContain("Stale (0)");
    expect(out).toContain("Conflicting (0");
    expect(out).toContain("Frequently used (0)");
    expect(out).toContain("(none)");
  });

  it("lists stale, conflicting pairs, and frequently-used records", () => {
    const a = rec({ id: "a", content: "x", category: "convention", scope: ["src/x.ts"] });
    const b = rec({ id: "b", content: "y", category: "convention", scope: ["src/x.ts"] });
    const hot = rec({ id: "hot", useCount: 9 });
    const out = formatAuditReport({
      stale: [a],
      conflicting: [[a, b]],
      frequentlyUsed: [hot],
      counts: {
        total: 3,
        active: 3,
        stale: 1,
        superseded: 0,
        conflicting: 1,
        frequentlyUsed: 1,
      },
    });
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("hot");
    expect(out).toContain("9");
    // a conflicting pair names both ids
    expect(out).toMatch(/a.*b|b.*a/);
  });
});

describe("runMemory", () => {
  function deps(workspaceDir: string) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      env: { OTTO_WORKSPACE: workspaceDir } as NodeJS.ProcessEnv,
      cwd: workspaceDir,
      out: (m: string) => out.push(m),
      err: (m: string) => err.push(m),
      _out: out,
      _err: err,
    };
  }

  it("audits the memory dir and prints the report (default subcommand)", async () => {
    const ws = tmp();
    writeMemoryRecord(ws, rec({ id: "x", useCount: 7 }));
    const d = deps(ws);
    const code = await runMemory(["audit"], d);
    expect(code).toBe(0);
    const text = d._out.join("\n");
    expect(text).toContain("Memory audit");
    expect(text).toContain("x");
  });

  it("projects active records to LEARNINGS markdown (project subcommand)", async () => {
    const ws = tmp();
    writeMemoryRecord(ws, rec({ id: "c", content: "a convention", category: "convention" }));
    const d = deps(ws);
    const code = await runMemory(["project"], d);
    expect(code).toBe(0);
    const text = d._out.join("\n");
    // raw LEARNINGS view — no "Memory audit" header that would corrupt a redirect
    expect(text).not.toContain("Memory audit");
    expect(text).toContain("# Otto learnings");
    expect(text).toContain("## Conventions\n\n- a convention");
  });

  it("handles an absent memory dir as an empty audit", async () => {
    const ws = tmp();
    const d = deps(ws);
    const code = await runMemory(["audit"], d);
    expect(code).toBe(0);
    expect(d._out.join("\n")).toContain("total:");
  });

  it("prints usage on --help and returns 0", async () => {
    const ws = tmp();
    const d = deps(ws);
    const code = await runMemory(["--help"], d);
    expect(code).toBe(0);
    expect(d._out.join("\n")).toMatch(/Usage: otto-memory/);
  });

  it("errors on an unknown subcommand", async () => {
    const ws = tmp();
    const d = deps(ws);
    const code = await runMemory(["bogus"], d);
    expect(code).toBe(1);
    expect(d._err.join("\n")).toMatch(/Usage: otto-memory/);
  });
});
