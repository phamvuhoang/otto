import { describe, it, expect } from "vitest";
import {
  newLedger,
  shouldAttestBoundary,
  maybeAttest,
  resolveAttestation,
  CHECKS_FAILED_REASON,
  type AttestationContext,
} from "../attestation.js";
import { DEFAULT_POLICY } from "../safety-policy.js";
import type { CheckCommandRunner } from "../checks.js";

const ctx = (
  commands: string[],
  run: CheckCommandRunner
): AttestationContext => ({
  commands,
  workspaceDir: "/w",
  policy: DEFAULT_POLICY,
  timeoutMs: 1000,
  run,
  now: () => "2026-07-31T00:00:00.000Z",
});

const green: CheckCommandRunner = () => ({ status: 0, output: "ok\n" });
const red: CheckCommandRunner = () => ({ status: 1, output: "FAIL x\n" });

describe("shouldAttestBoundary", () => {
  it("is true for the three HEAD-moving review stages", () => {
    expect(shouldAttestBoundary("reviewer")).toBe(true);
    expect(shouldAttestBoundary("review-synth")).toBe(true);
    expect(shouldAttestBoundary("apply-review-implementer")).toBe(true);
  });

  it("is false for read-only and implement stages", () => {
    for (const s of [
      "implementer",
      "plan",
      "verifier",
      "structural",
      "pr-review-lens",
    ]) {
      expect(shouldAttestBoundary(s)).toBe(false);
    }
  });
});

describe("maybeAttest", () => {
  it("is inert with no configured commands", () => {
    const l = newLedger();
    expect(maybeAttest(l, "reviewer", false, 1, ctx([], green))).toEqual([]);
    expect(l.entries).toHaveLength(0);
  });

  it("is inert for a non-boundary stage", () => {
    const l = newLedger();
    expect(maybeAttest(l, "implementer", false, 1, ctx(["t"], green))).toEqual(
      []
    );
    expect(l.entries).toHaveLength(0);
  });

  it("is inert when the stage errored (nothing was committed)", () => {
    const l = newLedger();
    expect(maybeAttest(l, "reviewer", true, 1, ctx(["t"], green))).toEqual([]);
    expect(l.entries).toHaveLength(0);
  });

  it("appends a ledger entry for a real boundary", () => {
    const l = newLedger();
    const records = maybeAttest(l, "reviewer", false, 2, ctx(["t"], green));
    expect(records).toHaveLength(1);
    expect(l.entries).toEqual([
      { boundary: "reviewer", iteration: 2, configuredCount: 1, records },
    ]);
  });

  it("records a thrown runner as a failure instead of throwing into the loop", () => {
    const l = newLedger();
    const explode: CheckCommandRunner = () => {
      throw new Error("spawn EACCES");
    };
    // The throw is absorbed one layer down, by runConfiguredChecks' own guard,
    // so the error text survives on the record rather than as a signature.
    // maybeAttest's catch stays as a defense-in-depth net for anything that
    // throws OUTSIDE that guard (e.g. a policy check).
    const records = maybeAttest(l, "reviewer", false, 1, ctx(["t"], explode));
    expect(records).toHaveLength(1);
    expect(records[0].exitCode).toBe(-1);
    expect(records[0].outputTail).toContain("EACCES");
    expect(records[0].failureSignature).toBe("exit -1");
    // Never a silent green: the failure reaches the verdict.
    expect(resolveAttestation(l).checksSummary!.terminalFailed).toBe(1);
  });
});

describe("resolveAttestation", () => {
  it("returns null summary when nothing was ever attested (inert run)", () => {
    expect(resolveAttestation(newLedger())).toEqual({
      checksSummary: null,
      exitReasonOverride: null,
    });
  });

  it("recovery: mid-run red then terminal green ⇒ succeeded-shaped result", () => {
    const l = newLedger();
    maybeAttest(l, "reviewer", false, 2, ctx(["t"], red));
    maybeAttest(l, "reviewer", false, 5, ctx(["t"], green));
    const { checksSummary, exitReasonOverride } = resolveAttestation(l);
    expect(checksSummary!.terminalFailed).toBe(0); // verdict: green
    expect(checksSummary!.everFailed).toBe(true); // churn evidence retained
    expect(checksSummary!.failed).toBe(1); // cumulative
    expect(checksSummary!.passed).toBe(1);
    expect(exitReasonOverride).toBeNull();
  });

  it("terminal red drives the override", () => {
    const l = newLedger();
    maybeAttest(l, "reviewer", false, 1, ctx(["t"], green));
    maybeAttest(l, "review-synth", false, 2, ctx(["t"], red));
    const { checksSummary, exitReasonOverride } = resolveAttestation(l);
    expect(checksSummary!.terminalFailed).toBe(1);
    expect(checksSummary!.everFailed).toBe(true);
    expect(exitReasonOverride).toBe(CHECKS_FAILED_REASON);
  });

  it("carries fail-fast skipped counts into the summary", () => {
    const l = newLedger();
    maybeAttest(l, "reviewer", false, 1, ctx(["a", "b", "c"], red));
    expect(resolveAttestation(l).checksSummary!.skipped).toBe(2);
  });
});
