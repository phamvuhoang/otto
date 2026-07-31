import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLAN_JUDGE_DIMENSIONS,
  formatPlanJudge,
  parsePlanJudgeVerdict,
  readPlanJudgeEnabled,
} from "../plan-judge.js";

const verdict = (over: Record<string, string> = {}): string => {
  const base: Record<string, string> = {
    alternativesWeighed: "MET | two approaches compared with a stated tradeoff",
    riskSubstance: "MET | names a rollback path for the migration",
    traceability: "UNMET | no test maps to requirement 3",
  };
  return Object.entries({ ...base, ...over })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
};

describe("parsePlanJudgeVerdict", () => {
  it("parses a complete verdict", () => {
    const s = parsePlanJudgeVerdict(verdict())!;
    expect(s.maxScore).toBe(3);
    expect(s.metCount).toBe(2);
    expect(s.ratio).toBeCloseTo(2 / 3);
    expect(s.missing).toEqual(["traceability"]);
    expect(s.results.find((r) => r.dimension === "riskSubstance")?.reason).toBe(
      "names a rollback path for the migration"
    );
  });

  it("fails OPEN when a dimension is missing", () => {
    // A broken judge must degrade to today's rubric-only gate, never block the
    // plan flow — so an incomplete verdict is null, not a partial score.
    const partial = "alternativesWeighed: MET | ok\nriskSubstance: MET | ok";
    expect(parsePlanJudgeVerdict(partial)).toBeNull();
  });

  it("fails open on unparseable prose", () => {
    expect(parsePlanJudgeVerdict("The plan looks good to me!")).toBeNull();
    expect(parsePlanJudgeVerdict("")).toBeNull();
  });

  it("tolerates surrounding prose and case", () => {
    const s = parsePlanJudgeVerdict(
      `I reviewed the plan.\n\n${verdict().toUpperCase()}\n\nDone.`
    );
    expect(s).not.toBeNull();
    expect(s!.maxScore).toBe(3);
  });

  it("covers every declared dimension", () => {
    const s = parsePlanJudgeVerdict(verdict())!;
    expect(s.results.map((r) => r.dimension).sort()).toEqual(
      PLAN_JUDGE_DIMENSIONS.map((d) => d.dimension).sort()
    );
  });
});

describe("formatPlanJudge", () => {
  it("renders a scorecard naming the unmet dimensions", () => {
    const out = formatPlanJudge(parsePlanJudgeVerdict(verdict())!);
    expect(out).toContain("2/3");
    expect(out).toContain("traceability");
    expect(out).toContain("no test maps to requirement 3");
  });
});

describe("readPlanJudgeEnabled", () => {
  const ws = (config?: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "otto-judge-"));
    if (config !== undefined) {
      mkdirSync(join(dir, ".otto"), { recursive: true });
      writeFileSync(join(dir, ".otto", "config.json"), JSON.stringify(config));
    }
    return dir;
  };

  it("is off by default", () => {
    expect(readPlanJudgeEnabled(ws(), {})).toBe(false);
    expect(readPlanJudgeEnabled(ws({ branchStrategy: "branch" }), {})).toBe(
      false
    );
  });

  it("honors precedence: flag > env > config", () => {
    const on = ws({ planJudge: true });
    const off = ws({ planJudge: false });
    expect(readPlanJudgeEnabled(off, {}, true)).toBe(true); // flag wins
    expect(readPlanJudgeEnabled(off, { OTTO_PLAN_JUDGE: "1" })).toBe(true);
    expect(readPlanJudgeEnabled(on, {})).toBe(true);
    expect(readPlanJudgeEnabled(on, { OTTO_PLAN_JUDGE: "0" })).toBe(false);
  });

  it("never throws on a malformed config", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-judge-"));
    mkdirSync(join(dir, ".otto"), { recursive: true });
    writeFileSync(join(dir, ".otto", "config.json"), "{ not json");
    expect(readPlanJudgeEnabled(dir, {})).toBe(false);
  });
});
