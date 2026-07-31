import { describe, it, expect } from "vitest";
import { formatAttestedChecks } from "../report-finalize.js";
import type { ChecksSummary } from "../attestation.js";

const summary = (over: Partial<ChecksSummary>): ChecksSummary => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  failureSignatures: [],
  everFailed: false,
  terminalFailed: 0,
  ...over,
});

describe("formatAttestedChecks", () => {
  it("is empty for an inert run", () => {
    expect(formatAttestedChecks(undefined)).toBe("");
  });

  it("reports a clean attestation", () => {
    const out = formatAttestedChecks(summary({ passed: 2 }));
    expect(out).toContain("Attested Checks");
    expect(out).toContain("2 passed");
    expect(out).not.toContain("DISAGREEMENT");
  });

  it("flags disagreement when the final state is red", () => {
    const out = formatAttestedChecks(
      summary({
        passed: 1,
        failed: 1,
        terminalFailed: 1,
        everFailed: true,
        failureSignatures: ["FAIL src/b.test.ts > adds"],
      })
    );
    expect(out).toContain("DISAGREEMENT");
    expect(out).toContain("the agent committed a fix");
    expect(out).toContain("FAIL src/b.test.ts > adds");
  });

  it("notes recovery when earlier iterations were red but the final state is green", () => {
    const out = formatAttestedChecks(
      summary({ passed: 2, failed: 1, everFailed: true, terminalFailed: 0 })
    );
    expect(out).not.toContain("DISAGREEMENT");
    expect(out).toContain("recovered");
  });

  it("discloses fail-fast skipped commands", () => {
    const out = formatAttestedChecks(
      summary({ failed: 1, skipped: 2, terminalFailed: 1 })
    );
    expect(out).toContain("2 not run (fail-fast)");
  });
});
