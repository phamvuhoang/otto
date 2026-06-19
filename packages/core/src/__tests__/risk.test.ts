import { describe, expect, it } from "vitest";

import {
  classifyRisk,
  reviewDepthForLevel,
  routeReview,
  selectLenses,
} from "../risk.js";

describe("classifyRisk", () => {
  it("classifies a docs-only change as low risk", () => {
    const r = classifyRisk(["README.md", "docs/ARCHITECTURE.md"]);
    expect(r.class).toBe("docs-only");
    expect(r.level).toBe("low");
  });

  it("classifies a test-only change as low risk", () => {
    const r = classifyRisk(["packages/core/src/__tests__/eval.test.ts"]);
    expect(r.class).toBe("test-only");
    expect(r.level).toBe("low");
  });

  it("classifies a single-module code change as narrow-code / medium", () => {
    const r = classifyRisk(["packages/core/src/eval.ts"]);
    expect(r.class).toBe("narrow-code");
    expect(r.level).toBe("medium");
  });

  it("classifies code spanning two top-level segments as cross-module / high", () => {
    const r = classifyRisk(["packages/core/src/eval.ts", "apps/cli/bin/x.js"]);
    expect(r.class).toBe("cross-module");
    expect(r.level).toBe("high");
  });

  it("classifies any security-sensitive path as high, even mixed with docs", () => {
    const r = classifyRisk(["docs/x.md", "packages/core/src/linear-auth.ts"]);
    expect(r.class).toBe("security-sensitive");
    expect(r.level).toBe("high");
    expect(r.reasons.join(" ")).toMatch(/auth/);
  });

  it("classifies a migration/release path as high", () => {
    for (const p of [
      "db/migrations/001_init.sql",
      "package.json",
      "pnpm-lock.yaml",
      "CHANGELOG.md",
    ]) {
      const r = classifyRisk([p]);
      expect(r.class, p).toBe("migration-release");
      expect(r.level, p).toBe("high");
    }
  });

  it("treats an empty path set as unknown / high (conservative)", () => {
    const r = classifyRisk([]);
    expect(r.class).toBe("unknown");
    expect(r.level).toBe("high");
  });

  it("ranks security above migration above cross-module above narrow", () => {
    // security wins over a co-changed migration path.
    expect(
      classifyRisk(["packages/core/src/auth.ts", "migrations/1.sql"]).class
    ).toBe("security-sensitive");
    // migration wins over a co-changed cross-module code spread.
    expect(
      classifyRisk(["packages/core/src/a.ts", "apps/cli/b.js", "x.sql"]).class
    ).toBe("migration-release");
  });

  it("records the triggering path in reasons", () => {
    const r = classifyRisk(["packages/core/src/eval.ts", "apps/cli/bin/x.js"]);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.join(" ")).toMatch(/packages|apps/);
  });
});

describe("reviewDepthForLevel", () => {
  it("maps every level to a depth", () => {
    expect(reviewDepthForLevel("low")).toBe("single");
    expect(reviewDepthForLevel("medium")).toBe("lenses");
    expect(reviewDepthForLevel("high")).toBe("panel");
  });
});

describe("selectLenses", () => {
  const available = ["correctness", "security", "tests"];

  it("selects no lenses for single-reviewer depth", () => {
    expect(selectLenses("single", available)).toEqual([]);
  });

  it("selects the full available set for panel depth", () => {
    expect(selectLenses("panel", available)).toEqual(available);
  });

  it("selects a capped subset for lenses depth", () => {
    expect(selectLenses("lenses", available)).toEqual(["correctness", "security"]);
  });

  it("never returns more than the available lenses", () => {
    expect(selectLenses("lenses", ["correctness"])).toEqual(["correctness"]);
    expect(selectLenses("panel", [])).toEqual([]);
  });
});

describe("routeReview", () => {
  const available = ["correctness", "security", "tests"];

  it("routes a docs-only change to a single reviewer (no lenses)", () => {
    const r = routeReview(["README.md"], available);
    expect(r.depth).toBe("single");
    expect(r.lenses).toEqual([]);
    expect(r.assessment.class).toBe("docs-only");
  });

  it("routes a narrow code change to a lens subset", () => {
    const r = routeReview(["packages/core/src/eval.ts"], available);
    expect(r.depth).toBe("lenses");
    expect(r.lenses).toEqual(["correctness", "security"]);
  });

  it("routes a security-sensitive change to the full panel", () => {
    const r = routeReview(["packages/core/src/auth.ts"], available);
    expect(r.depth).toBe("panel");
    expect(r.lenses).toEqual(available);
  });

  it("routes an unknown (no visible diff) change conservatively to the panel", () => {
    const r = routeReview([], available);
    expect(r.depth).toBe("panel");
    expect(r.lenses).toEqual(available);
  });
});
