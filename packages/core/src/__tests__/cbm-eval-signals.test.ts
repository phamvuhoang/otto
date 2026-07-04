import { describe, it, expect } from "vitest";
import { scoreImpactRecall } from "../eval.js";

describe("scoreImpactRecall", () => {
  it("full recall when every impacted file appears in the answer", () => {
    const r = scoreImpactRecall(
      ["src/a.ts", "src/b.ts"],
      "changing src/a.ts also breaks src/b.ts"
    );
    expect(r).toBe(1);
  });
  it("partial recall when some impacted files are missing", () => {
    const r = scoreImpactRecall(
      ["src/a.ts", "src/b.ts"],
      "only src/a.ts matters"
    );
    expect(r).toBeCloseTo(0.5, 5);
  });
});
