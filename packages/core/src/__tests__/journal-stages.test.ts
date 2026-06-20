import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STAGES } from "../stages.js";

const templatePath = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

describe("journal stages", () => {
  it("registers journalWrite + journalScreen with templates that ship", () => {
    for (const stage of [STAGES.journalWrite, STAGES.journalScreen]) {
      expect(stage.permissionMode).toBe("bypassPermissions");
      expect(existsSync(templatePath(stage.template))).toBe(true);
    }
  });
  it("the screen template asks for the exact verdict tag", () => {
    const t = readFileSync(templatePath(STAGES.journalScreen.template), "utf8");
    expect(t).toContain("<journal-verdict>SAFE</journal-verdict>");
    expect(t).toContain("{{ INPUTS }}");
  });
});
