import { describe, it, expect } from "vitest";
import {
  extractFailureSignature,
  summarizeChecks,
  type ChecksRecord,
} from "../checks.js";

const record = (over: Partial<ChecksRecord>): ChecksRecord => ({
  command: "pnpm -r test",
  exitCode: 0,
  durationMs: 100,
  outputTail: "",
  failureSignature: null,
  attestedAt: "2026-07-31T00:00:00.000Z",
  ...over,
});

describe("extractFailureSignature", () => {
  it("extracts the first vitest failure line, ANSI-stripped", () => {
    const tail =
      "  \u001b[32m✓\u001b[0m src/a.test.ts (3 tests)\n" +
      "  \u001b[31mFAIL\u001b[0m  src/b.test.ts > summarize > tallies\n" +
      "  another FAIL line\n";
    expect(extractFailureSignature(tail)).toBe(
      "FAIL src/b.test.ts > summarize > tallies"
    );
  });

  it("extracts a tsc error line", () => {
    const tail = "src/x.ts(3,1): error TS2304: Cannot find name 'y'.\n";
    expect(extractFailureSignature(tail)).toBe(
      "src/x.ts(3,1): error TS2304: Cannot find name 'y'."
    );
  });

  it("is stable across differing durations", () => {
    const a = extractFailureSignature("✗ compress survives (312ms)");
    const b = extractFailureSignature("✗ compress survives (7ms)");
    expect(a).toBe(b);
    expect(a).toContain("<duration>");
  });

  it("returns null when no failure marker is present", () => {
    expect(extractFailureSignature("all 42 tests passed\n")).toBeNull();
  });

  it("caps the signature at 200 chars", () => {
    const sig = extractFailureSignature(`FAIL ${"x".repeat(500)}`);
    expect(sig).not.toBeNull();
    expect(sig!.length).toBeLessThanOrEqual(200);
  });
});

describe("summarizeChecks", () => {
  it("tallies passed and failed", () => {
    const s = summarizeChecks(
      [
        record({ exitCode: 0 }),
        record({ exitCode: 1, failureSignature: "FAIL a" }),
      ],
      2
    );
    expect(s).toEqual({
      passed: 1,
      failed: 1,
      skipped: 0,
      failureSignatures: ["FAIL a"],
    });
  });

  it("reports fail-fast skipped commands", () => {
    // 3 configured, ladder stopped after the first failure ⇒ 2 never ran.
    const s = summarizeChecks(
      [record({ exitCode: 1, failureSignature: "FAIL a" })],
      3
    );
    expect(s.skipped).toBe(2);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(1);
  });

  it("dedupes signatures and falls back to the exit code", () => {
    const s = summarizeChecks(
      [
        record({ exitCode: 1, failureSignature: "FAIL a" }),
        record({ exitCode: 1, failureSignature: "FAIL a" }),
        record({ exitCode: 2, failureSignature: null }),
      ],
      3
    );
    expect(s.failureSignatures).toEqual(["FAIL a", "exit 2"]);
  });

  it("never reports negative skipped when records exceed the config", () => {
    expect(summarizeChecks([record({}), record({})], 1).skipped).toBe(0);
  });
});
