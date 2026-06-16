import { describe, expect, it, vi } from "vitest";

import { runLinearAuth, type LinearAuthCliDeps } from "../linear-auth.js";

const CONFIG = "/home/u/.config/otto/linear.json";

// A recording deps harness with sensible defaults; override per test.
function harness(over: Partial<LinearAuthCliDeps> = {}) {
  const writes: Array<{ path: string; contents: string; mode: number }> = [];
  const removed: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: LinearAuthCliDeps = {
    env: {},
    home: "/home/u",
    readFile: () => null,
    writeFile: (path, contents, mode) => writes.push({ path, contents, mode }),
    removeFile: (path) => {
      removed.push(path);
      return true;
    },
    readStdin: async () => "",
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    verify: async () => ({ id: "u1", name: "Ada", email: "a@b.c" }),
    ...over,
  };
  return { deps, writes, removed, out, err };
}

describe("runLinearAuth login", () => {
  it("writes the pasted key to the config path as 0600 JSON and returns 0", async () => {
    const { deps, writes, out } = harness({ readStdin: async () => "lin_api_abc" });

    const code = await runLinearAuth(["login"], deps);

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(CONFIG);
    expect(writes[0].mode).toBe(0o600);
    expect(JSON.parse(writes[0].contents)).toEqual({
      type: "apiKey",
      token: "lin_api_abc",
    });
    // never echoes the secret back
    expect(out.join("\n")).not.toContain("lin_api_abc");
    expect(out.join("\n")).toContain(CONFIG);
  });

  it("trims surrounding whitespace/newlines from the pasted key", async () => {
    const { deps, writes } = harness({ readStdin: async () => "  key\n" });

    await runLinearAuth(["login"], deps);

    expect(JSON.parse(writes[0].contents).token).toBe("key");
  });

  it("rejects an empty paste without writing anything", async () => {
    const { deps, writes, err } = harness({ readStdin: async () => "  \n" });

    const code = await runLinearAuth(["login"], deps);

    expect(code).toBe(1);
    expect(writes).toHaveLength(0);
    expect(err.join("\n")).toMatch(/no api key/i);
  });
});

describe("runLinearAuth status", () => {
  it("reports the resolved source without printing the token and returns 0", async () => {
    const { deps, out } = harness({
      env: { OTTO_LINEAR_API_KEY: "secret-token" },
    });

    const code = await runLinearAuth(["status"], deps);

    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("OTTO_LINEAR_API_KEY");
    expect(printed).not.toContain("secret-token");
  });

  it("returns 1 and points at login when no credential resolves", async () => {
    const { deps, out } = harness();

    const code = await runLinearAuth(["status"], deps);

    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/otto-linear-auth login/);
  });

  it("resolves a credential from the config file", async () => {
    const { deps, out } = harness({
      readFile: (p) =>
        p === CONFIG ? JSON.stringify({ type: "apiKey", token: "file-key" }) : null,
    });

    const code = await runLinearAuth(["status"], deps);

    expect(code).toBe(0);
    expect(out.join("\n")).toContain(CONFIG);
  });

  it("--verify-live calls the API with the resolved token and prints the viewer", async () => {
    const verify = vi.fn(async () => ({ id: "u1", name: "Ada", email: "a@b.c" }));
    const { deps, out } = harness({
      env: { OTTO_LINEAR_API_KEY: "secret-token" },
      verify,
    });

    const code = await runLinearAuth(["status", "--verify-live"], deps);

    expect(code).toBe(0);
    expect(verify).toHaveBeenCalledWith("secret-token");
    expect(out.join("\n")).toMatch(/Ada/);
  });

  it("--verify-live returns 1 when the live check fails", async () => {
    const { LinearApiError } = await import("../linear-api.js");
    const verify = vi.fn(async () => {
      throw new LinearApiError("bad key", "auth", 401);
    });
    const { deps, err } = harness({
      env: { OTTO_LINEAR_API_KEY: "secret-token" },
      verify,
    });

    const code = await runLinearAuth(["status", "--verify-live"], deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/bad key|auth/i);
  });

  it("--verify-live without any credential returns 1 and never calls the API", async () => {
    const verify = vi.fn();
    const { deps } = harness({ verify });

    const code = await runLinearAuth(["status", "--verify-live"], deps);

    expect(code).toBe(1);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("runLinearAuth logout", () => {
  it("removes the config file and returns 0", async () => {
    const { deps, removed, out } = harness({ removeFile: () => true });

    const code = await runLinearAuth(["logout"], deps);

    expect(code).toBe(0);
    expect(out.join("\n")).toContain(CONFIG);
  });

  it("returns 0 with a clear message when no file exists", async () => {
    const { deps, out } = harness({ removeFile: () => false });

    const code = await runLinearAuth(["logout"], deps);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/no stored credential|nothing/i);
  });

  it("warns that an env-var credential still takes precedence", async () => {
    const { deps, out } = harness({
      env: { LINEAR_API_KEY: "still-set" },
      removeFile: () => true,
    });

    await runLinearAuth(["logout"], deps);

    expect(out.join("\n")).toMatch(/LINEAR_API_KEY/);
  });
});

describe("runLinearAuth usage", () => {
  it("returns 2 on an unknown subcommand", async () => {
    const { deps, err } = harness();
    const code = await runLinearAuth(["frobnicate"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/login|status|logout/);
  });

  it("returns 2 when no subcommand is given", async () => {
    const { deps, err } = harness();
    const code = await runLinearAuth([], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/usage/i);
  });
});
