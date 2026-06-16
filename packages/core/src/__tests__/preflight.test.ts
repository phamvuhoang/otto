import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { runPreflight, whichBin, type PreflightProbes } from "../preflight.js";

/** Probes where everything is present; tests flip individual pieces off. */
function allPresentProbes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    resolveBin: () => "/usr/local/bin/found",
    pathExists: () => true,
    home: "/home/user",
    ...overrides,
  };
}

function byLabel(results: ReturnType<typeof runPreflight>) {
  return Object.fromEntries(results.map((r) => [r.label, r]));
}

describe("runPreflight", () => {
  it("reports all prerequisites ok when everything is present (otto-afk)", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo" },
      allPresentProbes()
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("omits gh checks for otto-afk and includes them for otto-ghafk", () => {
    const afk = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo" },
      allPresentProbes()
    );
    const ghafk = runPreflight(
      { bin: "otto-ghafk", workspaceDir: "/repo" },
      allPresentProbes()
    );
    expect(afk.map((r) => r.label)).not.toContain("gh CLI");
    expect(afk.map((r) => r.label)).not.toContain("gh auth");
    expect(ghafk.map((r) => r.label)).toContain("gh CLI");
    expect(ghafk.map((r) => r.label)).toContain("gh auth");
  });

  it("flags a missing claude CLI with a remediation hint", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo" },
      allPresentProbes({ resolveBin: (n) => (n === "claude" ? null : "/bin/x") })
    );
    const claude = byLabel(results)["claude CLI"];
    expect(claude.ok).toBe(false);
    expect(claude.detail).toMatch(/PATH/);
  });

  it("flags missing claude auth when no credential path exists", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo" },
      allPresentProbes({ pathExists: () => false })
    );
    const auth = byLabel(results)["claude auth"];
    expect(auth.ok).toBe(false);
    expect(auth.detail).toMatch(/claude \/login/);
  });

  it("treats ~/.claude.json OR ~/.claude as sufficient for claude auth", () => {
    const onlyJson = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo" },
      allPresentProbes({
        pathExists: (p) => p === join("/home/user", ".claude.json"),
      })
    );
    expect(byLabel(onlyJson)["claude auth"].ok).toBe(true);

    const onlyDir = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo" },
      allPresentProbes({
        pathExists: (p) => p === join("/home/user", ".claude"),
      })
    );
    expect(byLabel(onlyDir)["claude auth"].ok).toBe(true);
  });

  it("flags a workspace that is not a git repo", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo" },
      allPresentProbes({ pathExists: (p) => p !== join("/repo", ".git") })
    );
    const git = byLabel(results)["workspace git repo"];
    expect(git.ok).toBe(false);
    expect(git.detail).toMatch(/git repo/);
  });

  it("flags missing gh auth for otto-ghafk", () => {
    const results = runPreflight(
      { bin: "otto-ghafk", workspaceDir: "/repo" },
      allPresentProbes({
        pathExists: (p) => p !== join("/home/user", ".config", "gh"),
      })
    );
    const ghAuth = byLabel(results)["gh auth"];
    expect(ghAuth.ok).toBe(false);
    expect(ghAuth.detail).toMatch(/gh auth login/);
  });
});

describe("whichBin", () => {
  it("resolves a binary that exists on a synthetic PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-which-"));
    const name = process.platform === "win32" ? "tool.exe" : "tool";
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    const env = { PATH: dir, PATHEXT: ".exe" };
    expect(whichBin("tool", env)).toBe(file);
  });

  it("returns null when the binary is not on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "otto-which-"));
    const env = { PATH: dir, PATHEXT: ".EXE" };
    expect(whichBin("definitely-not-here", env)).toBeNull();
  });

  it("searches every PATH entry in order", () => {
    const empty = mkdtempSync(join(tmpdir(), "otto-which-a-"));
    const real = mkdtempSync(join(tmpdir(), "otto-which-b-"));
    const name = process.platform === "win32" ? "tool.exe" : "tool";
    const file = join(real, name);
    writeFileSync(file, "");
    const env = { PATH: [empty, real].join(delimiter), PATHEXT: ".exe" };
    expect(whichBin("tool", env)).toBe(file);
  });
});
