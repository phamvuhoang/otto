import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { resolveLinearAuth, type LinearAuth } from "./linear-api.js";

/** One prerequisite check rendered by `--print-config`. */
export type PreflightResult = { label: string; ok: boolean; detail: string };

/**
 * Injectable probes so `runPreflight` stays pure and unit-testable without real
 * binaries or a real home dir. Defaults wire up the host environment.
 */
export type PreflightProbes = {
  /** Resolve a binary on PATH; return its full path or null when absent. */
  resolveBin: (name: string) => string | null;
  /** Does a filesystem path exist? */
  pathExists: (p: string) => boolean;
  /** Home directory holding credential files. */
  home: string;
  /** Resolve the stored/env Linear credential (for otto-linear-afk), or null. */
  linearAuth: () => LinearAuth | null;
};

/**
 * Minimal `which`: walk PATH (honouring PATHEXT on Windows, like render.ts's
 * shell resolution) and return the first matching executable, or null.
 * `env` is injectable for testing.
 */
export function whichBin(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const defaultProbes: PreflightProbes = {
  resolveBin: (name) => whichBin(name),
  pathExists: existsSync,
  home: homedir(),
  linearAuth: () => resolveLinearAuth(),
};

/**
 * Diagnose the prerequisites a run needs before any paid `claude` invocation:
 * the agent CLI, its credentials, a git workspace to commit into, and — for
 * otto-ghafk — the `gh` CLI and its credentials. Reports only; never throws.
 */
export function runPreflight(
  opts: { bin: string; workspaceDir: string },
  probes: PreflightProbes = defaultProbes
): PreflightResult[] {
  const { resolveBin, pathExists, home, linearAuth } = probes;
  const results: PreflightResult[] = [];

  const claude = resolveBin("claude");
  results.push({
    label: "claude CLI",
    ok: claude != null,
    detail: claude ?? "not found on PATH — install Claude Code",
  });

  const claudeAuth =
    pathExists(join(home, ".claude.json")) || pathExists(join(home, ".claude"));
  results.push({
    label: "claude auth",
    ok: claudeAuth,
    detail: claudeAuth ? "credentials found" : "run `claude /login`",
  });

  const git = pathExists(join(opts.workspaceDir, ".git"));
  results.push({
    label: "workspace git repo",
    ok: git,
    detail: git ? opts.workspaceDir : "not a git repo — Otto commits here",
  });

  if (opts.bin === "otto-ghafk") {
    const gh = resolveBin("gh");
    results.push({
      label: "gh CLI",
      ok: gh != null,
      detail: gh ?? "not found on PATH — install GitHub CLI",
    });
    const ghAuth = pathExists(join(home, ".config", "gh"));
    results.push({
      label: "gh auth",
      ok: ghAuth,
      detail: ghAuth ? "credentials found" : "run `gh auth login`",
    });
  }

  if (opts.bin === "otto-linear-afk") {
    const auth = linearAuth();
    results.push({
      label: "linear auth",
      ok: auth != null,
      detail: auth
        ? `credentials found (${auth.source})`
        : "run `otto-linear-auth login`",
    });
  }

  return results;
}
