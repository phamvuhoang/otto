import { describe, expect, it } from "vitest";

import {
  DEFAULT_LADDER,
  resolveStageModel,
  resolveTierLadder,
  routeModel,
} from "../model-tier.js";
import type { RiskAssessment } from "../risk.js";
import { STAGES } from "../stages.js";

describe("resolveTierLadder", () => {
  it("returns the default ladder with no env overrides", () => {
    expect(resolveTierLadder({})).toEqual(DEFAULT_LADDER);
    expect(DEFAULT_LADDER).toEqual({
      cheap: "haiku",
      mid: "sonnet",
      strong: "opus",
    });
  });

  it("overlays per-tier env overrides, ignoring blank values", () => {
    const ladder = resolveTierLadder({
      OTTO_TIER_CHEAP: "claude-haiku-4-5",
      OTTO_TIER_MID: "  ",
      OTTO_TIER_STRONG: "opus",
    });
    expect(ladder).toEqual({
      cheap: "claude-haiku-4-5",
      mid: "sonnet",
      strong: "opus",
    });
  });
});

describe("resolveStageModel", () => {
  const ladder = DEFAULT_LADDER;

  it("returns the runtime default when routing is off", () => {
    const r = resolveStageModel({
      runtimeId: "claude",
      stage: STAGES.implementer,
      routing: false,
      ladder,
      env: {},
    });
    expect(r).toEqual({ spec: undefined, source: "default" });
  });

  it("a pinned OTTO_MODEL wins and disables routing", () => {
    const r = resolveStageModel({
      runtimeId: "claude",
      stage: STAGES.implementer,
      routing: true,
      ladder,
      env: { OTTO_MODEL: "my-pin" },
    });
    expect(r).toEqual({ spec: "my-pin", source: "pin" });
  });

  it("routes the stage's base tier through the ladder when on", () => {
    const r = resolveStageModel({
      runtimeId: "claude",
      stage: STAGES.reviewer,
      routing: true,
      ladder,
      env: {},
    });
    expect(r).toMatchObject({ spec: "opus", tier: "strong", source: "route" });
  });

  it("leaves a tier-less stage on the runtime default even with routing on", () => {
    const r = resolveStageModel({
      runtimeId: "claude",
      stage: { name: "x", template: "x.md" },
      routing: true,
      ladder,
      env: {},
    });
    expect(r).toEqual({ spec: undefined, source: "default" });
  });
});

describe("routeModel", () => {
  const risk = (cls: string): RiskAssessment =>
    ({ class: cls, level: "medium", reasons: [] }) as RiskAssessment;

  it("returns the base tier with no signals", () => {
    expect(routeModel({ baseTier: "mid" }).tier).toBe("mid");
  });
  it("downgrades docs-only / test-only one tier (floor cheap)", () => {
    expect(routeModel({ baseTier: "mid", assessment: risk("docs-only") }).tier).toBe(
      "cheap"
    );
    expect(
      routeModel({ baseTier: "cheap", assessment: risk("test-only") }).tier
    ).toBe("cheap");
  });
  it("upgrades security-sensitive / cross-module to strong", () => {
    expect(
      routeModel({ baseTier: "mid", assessment: risk("security-sensitive") }).tier
    ).toBe("strong");
    expect(
      routeModel({ baseTier: "cheap", assessment: risk("cross-module") }).tier
    ).toBe("strong");
  });
  it("escalation raises one tier per prior escalation, capped at strong", () => {
    expect(routeModel({ baseTier: "cheap", escalations: 1 }).tier).toBe("mid");
    expect(routeModel({ baseTier: "mid", escalations: 1 }).tier).toBe("strong");
    expect(routeModel({ baseTier: "mid", escalations: 5 }).tier).toBe("strong");
  });
  it("risk-up then escalation both clamp at strong", () => {
    expect(
      routeModel({
        baseTier: "strong",
        assessment: risk("security-sensitive"),
        escalations: 2,
      }).tier
    ).toBe("strong");
  });
  it("records the reasons that drove the decision", () => {
    const r = routeModel({ baseTier: "mid", assessment: risk("docs-only"), escalations: 1 });
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
