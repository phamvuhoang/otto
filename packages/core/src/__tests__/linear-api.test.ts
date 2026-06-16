import { describe, expect, it } from "vitest";

import {
  linearConfigPath,
  parseLinearRef,
  resolveLinearAuth,
} from "../linear-api.js";

describe("parseLinearRef", () => {
  it("accepts a bare identifier", () => {
    expect(parseLinearRef("ENG-123")).toEqual({
      kind: "identifier",
      identifier: "ENG-123",
    });
  });
  it("uppercases the team key", () => {
    expect(parseLinearRef("eng-123")).toEqual({
      kind: "identifier",
      identifier: "ENG-123",
    });
  });
  it("accepts an alphanumeric team key", () => {
    expect(parseLinearRef("ENG2-7")).toEqual({
      kind: "identifier",
      identifier: "ENG2-7",
    });
  });
  it("accepts a Linear issue URL with a slug", () => {
    expect(
      parseLinearRef("https://linear.app/acme/issue/ENG-123/some-title-here")
    ).toEqual({ kind: "identifier", identifier: "ENG-123" });
  });
  it("accepts a Linear issue URL without a slug", () => {
    expect(parseLinearRef("https://linear.app/acme/issue/ENG-123")).toEqual({
      kind: "identifier",
      identifier: "ENG-123",
    });
  });
  it("uppercases the identifier extracted from a URL", () => {
    expect(parseLinearRef("https://linear.app/acme/issue/eng-9/x")).toEqual({
      kind: "identifier",
      identifier: "ENG-9",
    });
  });
  it("accepts an issue UUID and lowercases it", () => {
    expect(
      parseLinearRef("9BDA4F9E-1C2D-4E3F-8A9B-0C1D2E3F4A5B")
    ).toEqual({
      kind: "uuid",
      uuid: "9bda4f9e-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
    });
  });
  it("trims surrounding whitespace", () => {
    expect(parseLinearRef("  ENG-123  ")).toEqual({
      kind: "identifier",
      identifier: "ENG-123",
    });
  });
  it.each([
    "",
    "ENG",
    "ENG-",
    "-123",
    "ENG-0",
    "ENG-007",
    "123",
    "1ENG-2",
    "ENG_123",
    "ENG-12x",
    "$(rm -rf ~)",
    "ENG-12;rm",
    "ENG 12",
    "not-a-uuid-0000-0000-000000000000",
  ])("rejects %j", (bad) => {
    expect(() => parseLinearRef(bad)).toThrow();
  });
});

describe("linearConfigPath", () => {
  it("resolves under ~/.config/otto/linear.json", () => {
    expect(linearConfigPath("/home/u")).toBe(
      "/home/u/.config/otto/linear.json"
    );
  });
});

describe("resolveLinearAuth", () => {
  const noFile = () => null;
  const filePath = "/home/u/.config/otto/linear.json";
  const fileWith = (token: unknown) => (p: string) =>
    p === filePath ? JSON.stringify({ type: "apiKey", token }) : null;

  it("prefers OTTO_LINEAR_API_KEY over everything", () => {
    expect(
      resolveLinearAuth({
        env: { OTTO_LINEAR_API_KEY: "otto-key", LINEAR_API_KEY: "linear-key" },
        readFile: fileWith("file-key"),
        home: "/home/u",
      })
    ).toEqual({ token: "otto-key", source: "OTTO_LINEAR_API_KEY" });
  });

  it("falls back to LINEAR_API_KEY when OTTO_LINEAR_API_KEY is unset", () => {
    expect(
      resolveLinearAuth({
        env: { LINEAR_API_KEY: "linear-key" },
        readFile: fileWith("file-key"),
        home: "/home/u",
      })
    ).toEqual({ token: "linear-key", source: "LINEAR_API_KEY" });
  });

  it("falls back to the config file when no env var is set", () => {
    expect(
      resolveLinearAuth({
        env: {},
        readFile: fileWith("file-key"),
        home: "/home/u",
      })
    ).toEqual({ token: "file-key", source: filePath });
  });

  it("returns null when no source has a credential", () => {
    expect(
      resolveLinearAuth({ env: {}, readFile: noFile, home: "/home/u" })
    ).toBeNull();
  });

  it("ignores empty/whitespace env vars and continues the precedence chain", () => {
    expect(
      resolveLinearAuth({
        env: { OTTO_LINEAR_API_KEY: "   ", LINEAR_API_KEY: "real" },
        readFile: noFile,
        home: "/home/u",
      })
    ).toEqual({ token: "real", source: "LINEAR_API_KEY" });
  });

  it("trims the resolved token", () => {
    expect(
      resolveLinearAuth({
        env: { OTTO_LINEAR_API_KEY: "  key  " },
        readFile: noFile,
        home: "/home/u",
      })
    ).toEqual({ token: "key", source: "OTTO_LINEAR_API_KEY" });
  });

  it("returns null when the config file is malformed JSON", () => {
    expect(
      resolveLinearAuth({
        env: {},
        readFile: () => "{ not json",
        home: "/home/u",
      })
    ).toBeNull();
  });

  it("returns null when the config file lacks a usable token", () => {
    expect(
      resolveLinearAuth({ env: {}, readFile: fileWith(""), home: "/home/u" })
    ).toBeNull();
    expect(
      resolveLinearAuth({
        env: {},
        readFile: fileWith(undefined),
        home: "/home/u",
      })
    ).toBeNull();
  });
});
