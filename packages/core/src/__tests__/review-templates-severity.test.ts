// packages/core/src/__tests__/review-templates-severity.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../templates/${rel}`, import.meta.url)), "utf8");

describe("review-verify severity contract", () => {
  it("requires verdicts to carry a severity and allows downgrade", () => {
    const t = read("review-verify.md");
    expect(t).toMatch(/CONFIRMED <severity>/);
    expect(t).toMatch(/downgrade/i);
  });
});

describe("review-synth severity contract", () => {
  it("fixes in severity order and suppresses nits when blockers/majors exist", () => {
    const t = read("review-synth.md");
    expect(t).toMatch(/severity order|highest severity first/i);
    expect(t).toMatch(/suppress|skip nits/i);
  });

  it("annotates the commit body with the findings addressed", () => {
    const t = read("review-synth.md");
    expect(t).toMatch(/Addressed:/);
    expect(t).toMatch(/file:line/);
  });
});
