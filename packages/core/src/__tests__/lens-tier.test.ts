// packages/core/src/__tests__/lens-tier.test.ts
import { describe, expect, it } from "vitest";
import { tierForLens } from "../model-tier.js";

describe("tierForLens", () => {
  it("routes structural and security to the strong tier", () => {
    expect(tierForLens("structural")).toBe("strong");
    expect(tierForLens("security")).toBe("strong");
  });
  it("routes mechanical lenses cheaper", () => {
    expect(tierForLens("tests")).toBe("cheap");
    expect(tierForLens("correctness")).toBe("mid");
  });
  it("defaults unknown lenses to mid", () => {
    expect(tierForLens("custom-thing")).toBe("mid");
  });
});
