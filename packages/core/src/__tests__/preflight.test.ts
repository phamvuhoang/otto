import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runPreflight,
  runReviewPreflight,
  whichBin,
  type PreflightProbes,
} from "../preflight.js";

/** Probes where everything is present; tests flip individual pieces off. */
function allPresentProbes(
  overrides: Partial<PreflightProbes> = {}
): PreflightProbes {
  return {
    resolveBin: () => "/usr/local/bin/found",
    pathExists: () => true,
    home: "/home/user",
    linearAuth: () => ({ token: "tok", source: "OTTO_LINEAR_API_KEY" }),
    probeVersion: () => true,
    env: { OPENAI_API_KEY: "sk-test" },
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
      allPresentProbes({
        resolveBin: (n) => (n === "claude" ? null : "/bin/x"),
      })
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

  it("includes a linear auth check only for otto-linear-afk", () => {
    const linear = runPreflight(
      { bin: "otto-linear-afk", workspaceDir: "/repo" },
      allPresentProbes()
    );
    const ghafk = runPreflight(
      { bin: "otto-ghafk", workspaceDir: "/repo" },
      allPresentProbes()
    );
    expect(linear.map((r) => r.label)).toContain("linear auth");
    expect(byLabel(linear)["linear auth"].ok).toBe(true);
    expect(ghafk.map((r) => r.label)).not.toContain("linear auth");
  });

  it("flags missing linear auth with a remediation hint", () => {
    const results = runPreflight(
      { bin: "otto-linear-afk", workspaceDir: "/repo" },
      allPresentProbes({ linearAuth: () => null })
    );
    const auth = byLabel(results)["linear auth"];
    expect(auth.ok).toBe(false);
    expect(auth.detail).toMatch(/otto-linear-auth login/);
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

  it("includes gh CLI/auth checks for otto-review (P32 automated review)", () => {
    const results = runPreflight(
      { bin: "otto-review", workspaceDir: "/repo" },
      allPresentProbes()
    );
    expect(results.map((r) => r.label)).toContain("gh CLI");
    expect(results.map((r) => r.label)).toContain("gh auth");
  });

  it("flags missing gh CLI for otto-review", () => {
    const results = runPreflight(
      { bin: "otto-review", workspaceDir: "/repo" },
      allPresentProbes({ resolveBin: (n) => (n === "gh" ? null : "/bin/x") })
    );
    const gh = byLabel(results)["gh CLI"];
    expect(gh.ok).toBe(false);
    expect(gh.detail).toMatch(/PATH/);
  });
});

describe("runReviewPreflight", () => {
  it("reports ok for a matching GitHub origin and an existing label", () => {
    const results = runReviewPreflight({
      workspaceDir: "/repo",
      repository: "acme/web",
      label: "otto-review",
      originUrl: "https://github.com/acme/web.git",
      labelExists: true,
    });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.label)).toContain("repository origin");
    expect(results.map((r) => r.label)).toContain("review label");
  });

  it("matches an origin case-insensitively and across remote URL forms", () => {
    const ssh = runReviewPreflight({
      workspaceDir: "/repo",
      repository: "acme/web",
      label: "otto-review",
      originUrl: "git@github.com:Acme/Web.git",
      labelExists: true,
    });
    expect(byLabel(ssh)["repository origin"].ok).toBe(true);
  });

  it("fails when the origin resolves to a different repository", () => {
    const results = runReviewPreflight({
      workspaceDir: "/repo",
      repository: "acme/web",
      label: "otto-review",
      originUrl: "https://github.com/other/repo.git",
      labelExists: true,
    });
    const origin = byLabel(results)["repository origin"];
    expect(origin.ok).toBe(false);
    expect(origin.detail).toMatch(/other\/repo/);
  });

  it("fails when the origin is missing", () => {
    const results = runReviewPreflight({
      workspaceDir: "/repo",
      repository: "acme/web",
      label: "otto-review",
      originUrl: null,
      labelExists: true,
    });
    const origin = byLabel(results)["repository origin"];
    expect(origin.ok).toBe(false);
  });

  it("fails when the origin is not a GitHub remote", () => {
    const results = runReviewPreflight({
      workspaceDir: "/repo",
      repository: "acme/web",
      label: "otto-review",
      originUrl: "https://gitlab.com/acme/web.git",
      labelExists: true,
    });
    const origin = byLabel(results)["repository origin"];
    expect(origin.ok).toBe(false);
  });

  it("fails when the label does not exist", () => {
    const results = runReviewPreflight({
      workspaceDir: "/repo",
      repository: "acme/web",
      label: "otto-review",
      originUrl: "https://github.com/acme/web.git",
      labelExists: false,
    });
    const label = byLabel(results)["review label"];
    expect(label.ok).toBe(false);
    expect(label.detail).toMatch(/otto-review/);
  });
});

describe("runPreflight codex runtime (issue #24 P3)", () => {
  it("reports claude CLI/auth rows by default and swaps to codex when agentId=codex", () => {
    const claude = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo" },
      allPresentProbes()
    );
    expect(claude.map((r) => r.label)).toContain("claude CLI");
    expect(claude.map((r) => r.label)).not.toContain("codex CLI");

    const codex = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes()
    );
    // The selected runtime's CLI/auth rows replace claude's — Claude-specific
    // checks are not shown blindly for a codex run.
    expect(codex.map((r) => r.label)).toContain("codex CLI");
    expect(codex.map((r) => r.label)).toContain("codex auth");
    expect(codex.map((r) => r.label)).not.toContain("claude CLI");
    expect(codex.map((r) => r.label)).not.toContain("claude auth");
  });

  it("reports codex CLI ok when on PATH and `codex --version` succeeds", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes({ resolveBin: () => "/opt/homebrew/bin/codex" })
    );
    const cli = byLabel(results)["codex CLI"];
    expect(cli.ok).toBe(true);
    expect(cli.detail).toBe("/opt/homebrew/bin/codex");
  });

  it("flags a shim-present-but-broken codex (version fails) as unusable, not found", () => {
    // The npm shim can sit on PATH while its vendored native binary is missing,
    // so `which codex` succeeds but `codex --version` does not (issue #24 P2 gap #5).
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes({
        resolveBin: () => "/opt/homebrew/bin/codex",
        probeVersion: () => false,
      })
    );
    const cli = byLabel(results)["codex CLI"];
    expect(cli.ok).toBe(false);
    expect(cli.detail).toMatch(/codex --version/);
    expect(cli.detail).toMatch(/\/opt\/homebrew\/bin\/codex/);
  });

  it("flags a missing codex CLI with an install hint", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes({ resolveBin: () => null })
    );
    const cli = byLabel(results)["codex CLI"];
    expect(cli.ok).toBe(false);
    expect(cli.detail).toMatch(/PATH/);
    expect(cli.detail).toMatch(/@openai\/codex/);
  });

  it("accepts ~/.codex/auth.json as codex auth", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes({
        env: {},
        pathExists: (p) => p === join("/home/user", ".codex", "auth.json"),
      })
    );
    const auth = byLabel(results)["codex auth"];
    expect(auth.ok).toBe(true);
    expect(auth.detail).toMatch(/auth\.json/);
  });

  it("accepts CODEX_API_KEY as codex auth when no auth file exists", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes({
        pathExists: () => false,
        env: { CODEX_API_KEY: "sk-live" },
      })
    );
    const auth = byLabel(results)["codex auth"];
    expect(auth.ok).toBe(true);
    expect(auth.detail).toMatch(/CODEX_API_KEY/);
  });

  it("accepts OPENAI_API_KEY as compatibility codex auth when no auth file exists", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes({
        pathExists: () => false,
        env: { OPENAI_API_KEY: "sk-live" },
      })
    );
    const auth = byLabel(results)["codex auth"];
    expect(auth.ok).toBe(true);
    expect(auth.detail).toMatch(/OPENAI_API_KEY/);
    expect(auth.detail).toMatch(/CODEX_API_KEY/);
  });

  it("flags missing codex auth with a remediation hint", () => {
    const results = runPreflight(
      { bin: "otto-afk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes({ pathExists: () => false, env: {} })
    );
    const auth = byLabel(results)["codex auth"];
    expect(auth.ok).toBe(false);
    expect(auth.detail).toMatch(/codex login/);
    expect(auth.detail).toMatch(/CODEX_API_KEY/);
    expect(auth.detail).toMatch(/OPENAI_API_KEY/);
  });

  it("still includes the workspace git row for a codex run", () => {
    const results = runPreflight(
      { bin: "otto-ghafk", workspaceDir: "/repo", agentId: "codex" },
      allPresentProbes()
    );
    expect(results.map((r) => r.label)).toContain("workspace git repo");
    // gh rows are per-bin and independent of the runtime.
    expect(results.map((r) => r.label)).toContain("gh CLI");
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
