import { describe, it, expect } from "vitest";
import {
  newLedger,
  maybeAttest,
  resolveAttestation,
  type AttestationContext,
} from "../attestation.js";
import { DEFAULT_POLICY } from "../safety-policy.js";
import type { CheckCommandRunner, ChecksRecord } from "../checks.js";

/** Mirror of the loop's `recordStage` attestation seam (loop.ts:775). */
function recordStageLike(
  ledger: ReturnType<typeof newLedger>,
  ctx: AttestationContext,
  stageName: string,
  isError: boolean,
  iteration: number
): { stage: string; checks?: ChecksRecord[] } {
  const checks = maybeAttest(ledger, stageName, isError, iteration, ctx);
  return { stage: stageName, ...(checks.length > 0 ? { checks } : {}) };
}

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

describe("recordStage attestation seam", () => {
  it("attaches checks to a reviewer record", () => {
    const l = newLedger();
    const rec = recordStageLike(l, ctx(["t"], green), "reviewer", false, 1);
    expect(rec.checks).toHaveLength(1);
    expect(rec.checks![0].exitCode).toBe(0);
  });

  it("attaches checks to a panel synth record (same closure)", () => {
    const l = newLedger();
    const rec = recordStageLike(l, ctx(["t"], red), "review-synth", false, 1);
    expect(rec.checks![0].exitCode).toBe(1);
  });

  it("leaves implementer and lens records untouched", () => {
    const l = newLedger();
    expect(
      recordStageLike(l, ctx(["t"], green), "implementer", false, 1).checks
    ).toBeUndefined();
    expect(
      recordStageLike(l, ctx(["t"], green), "structural", false, 1).checks
    ).toBeUndefined();
    expect(l.entries).toHaveLength(0);
  });

  it("is inert end-to-end with no checks configured", () => {
    const l = newLedger();
    const rec = recordStageLike(l, ctx([], green), "reviewer", false, 1);
    expect(rec.checks).toBeUndefined();
    expect(resolveAttestation(l).checksSummary).toBeNull();
  });

  it("a multi-iteration run resolves on the terminal boundary", () => {
    const l = newLedger();
    recordStageLike(l, ctx(["t"], red), "reviewer", false, 2);
    recordStageLike(l, ctx(["t"], green), "reviewer", false, 5);
    const { checksSummary } = resolveAttestation(l);
    expect(checksSummary!.terminalFailed).toBe(0);
    expect(checksSummary!.everFailed).toBe(true);
  });
});
