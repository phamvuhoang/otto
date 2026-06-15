import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearState,
  matchesResume,
  readState,
  writeState,
  type RunState,
} from "../state.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "otto-state-"));
}
const sample: RunState = {
  bin: "otto-afk",
  mode: "afk",
  inputs: "plan prd",
  iteration: 11,
  of: 30,
  status: "running",
  resetsAt: null,
  startedAt: "2026-06-15T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
};

describe("state I/O", () => {
  it("returns null when absent", () => {
    expect(readState(tmp())).toBeNull();
  });
  it("returns null on malformed JSON", () => {
    const d = tmp();
    mkdirSync(join(d, ".otto"));
    writeFileSync(join(d, ".otto", "state.json"), "{ nope");
    expect(readState(d)).toBeNull();
  });
  it("round-trips a write", () => {
    const d = tmp();
    writeState(d, sample);
    expect(readState(d)).toEqual(sample);
  });
  it("clearState removes the file and is safe when absent", () => {
    const d = tmp();
    writeState(d, sample);
    clearState(d);
    expect(existsSync(join(d, ".otto", "state.json"))).toBe(false);
    expect(() => clearState(d)).not.toThrow();
  });
});

describe("matchesResume", () => {
  const cur = { bin: "otto-afk", mode: "afk", inputs: "plan prd" };
  it("true for an unfinished run with matching identity", () => {
    expect(matchesResume(sample, cur)).toBe(true);
  });
  it("false when prior run completed", () => {
    expect(matchesResume({ ...sample, status: "complete" }, cur)).toBe(false);
  });
  it("false on bin/mode/inputs mismatch", () => {
    expect(matchesResume({ ...sample, inputs: "other" }, cur)).toBe(false);
    expect(matchesResume({ ...sample, mode: "ghafk" }, cur)).toBe(false);
    expect(matchesResume({ ...sample, bin: "otto-ghafk" }, cur)).toBe(false);
  });
  it("false when there is no prior state", () => {
    expect(matchesResume(null, cur)).toBe(false);
  });
});
