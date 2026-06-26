// Freebuff CLI adapter SPIKE harness (Phase 0 — throwaway, NOT production).
//
// Purpose: prove whether Freebuff CLI (`freebuff`) can satisfy Otto's
// non-interactive loop contract, and pin a candidate Freebuff-event → StageResult
// mapping for the production Freebuff adapter.
//
// Why it lives in scripts/ and not packages/core/src/: the repo's Phase 0 learning
// keeps Freebuff-specific parsing OUT of the runner until the spike reveals the
// signal shape (YAGNI). scripts/ is not in core's package `files`, so nothing
// here ships in the tarball. The production adapter would live in
// packages/core/src/runner.ts + preflight.ts.
//
// Background: Freebuff is the free, ad-supported version of Codebuff (npm install
// -g freebuff). Public source and docs show it as an interactive TUI app that does
// NOT accept initial prompt arguments in Freebuff mode. This spike investigates
// whether a headless `freebuff exec --json` contract exists or can be upstreamed.
//
// Candidate parser/preflight/argv builder below are unit-pinned by
// scripts/freebuff-spike.test.mjs against sample fixtures. Schemas marked
// "UNVERIFIED" still need a live-binary confirmation — the smoke could not run
// here (no freebuff binary present; this is exactly what the spike must determine).
//
// Run the smoke manually once a working `freebuff` is on PATH:
//   node scripts/freebuff-spike.mjs "summarize the README in one sentence"
//
// Open questions this spike probes (see docs/prd/freebuff-agent-runtime.md):
//   - Does freebuff support a headless prompt path at all?
//   - Can a prompt be passed via argv, stdin, or a documented subcommand?
//   - Does output expose JSONL suitable for StageResult mapping?
//   - What credential/session source is authoritative?
//   - Is there a native sandbox mode?

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** StageResult-shaped usage (mirrors packages/core/src/runner.ts emptyTokenUsage). */
const emptyUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

/** Minimal PATH `which` (mirrors preflight.ts whichBin), env-injectable. */
function whichBin(name, env = process.env) {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Normalize the input to an iterable of items. Accepts:
 *   - An array of objects or strings (as emitted by the runner line reader).
 *   - A single newline-delimited JSONL string (split into lines).
 */
function toItems(eventsOrLines) {
  if (typeof eventsOrLines === "string") return eventsOrLines.split("\n");
  return eventsOrLines;
}

/**
 * Freebuff preflight: three distinct checks.
 *
 *   cli     — `freebuff` resolvable on PATH.
 *   version — `freebuff --version` actually succeeds (catches launcher/native-binary
 *             mismatch, a known npm-installed-platform-binary failure mode).
 *             Requires an injectable `runVersion` probe so tests don't need the
 *             real binary; the live-smoke entrypoint can pass a real spawn probe.
 *   auth    — credential/session readiness from the verified Freebuff source:
 *             `~/.config/manicode/credentials.json` (Codebuff/Freebuff session store)
 *             OR `CODEBUFF_API_KEY` environment variable.
 *
 * Injectable probes (so unit tests pass fakes without spawning anything):
 *   resolveBin(name)  → path string or null.
 *   runVersion(bin)   → { ok: boolean, version?: string, error?: string }.
 *   pathExists(path)  → boolean.
 *   home              → home directory string.
 *   env               → environment object.
 */
export function freebuffPreflight(probes = {}) {
  const {
    resolveBin = (n) => whichBin(n),
    runVersion = null,
    pathExists = existsSync,
    home = homedir(),
    env = process.env,
  } = probes;

  // Check 1: CLI on PATH.
  const bin = resolveBin("freebuff");
  const cliOk = bin != null;

  // Check 2: version probe (detects launcher/native-binary mismatch).
  let versionOk = null; // null = not probed / unknown
  let versionDetail;
  if (!cliOk) {
    versionDetail = "freebuff --version not checked (binary not on PATH)";
  } else if (typeof runVersion === "function") {
    const res = runVersion(bin);
    versionOk = res.ok === true;
    versionDetail = res.ok
      ? `freebuff --version ok (${res.version ?? "version string unknown"})`
      : `freebuff --version failed — launcher/binary mismatch: ${res.error ?? "unknown error"}`;
  } else {
    // No probe injected; live smoke will handle this.
    versionDetail =
      "freebuff --version not probed (inject runVersion probe to verify)";
  }

  // Check 3: credential/session readiness.
  // Sources from Codebuff/Freebuff source:
  //   ~/.config/manicode/credentials.json — stored login session.
  //   CODEBUFF_API_KEY — API key override (works for Freebuff too).
  const credFile = pathExists(
    join(home, ".config", "manicode", "credentials.json")
  );
  const codebuffKey =
    typeof env.CODEBUFF_API_KEY === "string" && env.CODEBUFF_API_KEY !== "";
  const authed = credFile || codebuffKey;

  return {
    cli: {
      label: "freebuff CLI",
      ok: cliOk,
      detail: cliOk
        ? bin
        : "not found on PATH — install with: npm install -g freebuff",
    },
    version: {
      label: "freebuff --version",
      ok: versionOk,
      detail: versionDetail,
    },
    auth: {
      label: "freebuff auth",
      ok: authed,
      detail: authed
        ? credFile
          ? "credentials found (~/.config/manicode/credentials.json)"
          : "credentials found (CODEBUFF_API_KEY)"
        : "no credentials — run `freebuff` once to log in, or set CODEBUFF_API_KEY",
    },
  };
}

/**
 * Candidate argv for a non-interactive Freebuff stage.
 *
 * Preferred upstream contract (UNVERIFIED — not yet confirmed against a real binary):
 *
 *   freebuff exec --json --cwd <workspace> <prompt>
 *
 * The `exec` subcommand and `--json` flag are HYPOTHETICAL — modeled on Codex's
 * `codex exec --json` pattern. They do NOT appear in the current public Freebuff
 * docs or CLI help. If Freebuff adds headless support, this builder should be
 * updated to match the verified contract.
 *
 * Acceptable alternatives to explore in the live spike:
 *   freebuff --cwd <workspace> --json <prompt>
 *   freebuff --cwd <workspace> --prompt-file <path> --json
 *   stdin prompt with JSONL output and deterministic process exit
 *
 * Constraints:
 *   - MUST NOT emit Claude-only flags: --settings, --permission-mode
 *   - MUST NOT emit Codex-only flags: --ask-for-approval, --sandbox, --ignore-user-config,
 *     --skip-git-repo-check
 */
export function buildFreebuffArgs(promptRelPath, opts = {}) {
  const { cwd = "." } = opts;
  return [
    "freebuff",
    "exec", // UNVERIFIED: hypothetical headless subcommand
    "--json", // UNVERIFIED: hypothetical machine-readable output flag
    "--cwd",
    cwd,
    // Prompt instruction (mirrors Codex spike's "read from file" approach).
    `Read the full instructions from the file ./${promptRelPath} in the current workspace and execute them.`,
  ];
}

/**
 * Candidate Freebuff event stream → StageResult mapping.
 *
 * Event shapes are UNVERIFIED — these are hypothetical JSONL events modeled on
 * what a `freebuff exec --json` might emit if a headless mode existed. Actual
 * Freebuff output in interactive TUI mode is not JSONL.
 *
 * Candidate event types:
 *   { type: "task.completed", output: "..." }
 *     → maps result text; normal completion.
 *   { type: "session.error", message: "...", status?: "ended" }
 *     → isError=true; apiErrorStatus from message.
 *   { type: "session.status", status: "active"|"ended"|... }
 *     → terminal/limit statuses set isError=true; normal statuses ignored here
 *       (detectFreebuffLimit handles limit classification).
 *
 * Accepts either:
 *   - An array of already-parsed event objects.
 *   - An array of raw JSONL line strings (non-JSON lines are silently ignored).
 *   - A single newline-delimited JSONL string (split into lines first).
 */
export function parseFreebuffEvents(eventsOrLines) {
  let result = "";
  let isError = false;
  let apiErrorStatus = null;
  const usage = emptyUsage();

  // Terminal session statuses that represent non-recoverable failure.
  const TERMINAL_STATUSES = new Set([
    "rate_limited",
    "country_blocked",
    "banned",
    "takeover_prompt",
    "model_unavailable",
  ]);

  for (const raw of toItems(eventsOrLines)) {
    let ev = raw;
    if (typeof raw === "string") {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
    }
    if (!ev || typeof ev !== "object") continue;

    const type = ev.type;
    if (type === "task.completed") {
      // Successful completion: extract result text.
      if (typeof ev.output === "string") result = ev.output;
    } else if (type === "session.error") {
      // Session-level error with a message.
      isError = true;
      const msg = typeof ev.message === "string" ? ev.message : null;
      const status = typeof ev.status === "string" ? ev.status : null;
      apiErrorStatus = msg ?? status ?? "unknown session error";
    } else if (type === "session.status") {
      // Terminal session statuses are also errors (rate_limited, banned, etc.).
      // "queued" is a headless-not-ready signal; detectFreebuffLimit handles it.
      // "active"/"ended" are normal flow; ignore here.
      const status = typeof ev.status === "string" ? ev.status : null;
      if (status && TERMINAL_STATUSES.has(status)) {
        isError = true;
        const msg = typeof ev.message === "string" ? ev.message : null;
        apiErrorStatus = msg ?? status;
      }
    }
    // NOTE: costUsd stays 0; usage stays empty.
    // Freebuff is free/ad-supported and not known to expose token counts or USD cost.
  }

  return {
    result,
    costUsd: 0,
    isError,
    apiErrorStatus,
    usage,
    runtimeId: "freebuff",
  };
}

/**
 * Detect Freebuff session/limit states and classify them.
 *
 * Known Freebuff session statuses (from Codebuff source, inferred — UNVERIFIED
 * as CLI output):
 *   queued           → headless_not_ready (session not yet executing; retry or
 *                      wait, but not a stage result — headless automation cannot
 *                      safely wait for an interactive queue).
 *   active           → normal; not a limit.
 *   rate_limited     → rate_limit (retryable, no reset time surfaced → null).
 *   country_blocked  → fatal.
 *   banned           → fatal.
 *   takeover_prompt  → fatal (interactive prompt required; cannot proceed headlessly).
 *   ended            → normal completion; not a limit.
 *   model_unavailable→ fatal.
 *
 * Also detects rate-limit patterns in session.error messages (rate limit, quota,
 * too-many-sessions keywords).
 *
 * Returns a structured classification or null if no limit detected:
 *   { kind: "rate-limit",         message: string, resetsAt: null }
 *   { kind: "headless-not-ready", message: string }
 *   { kind: "fatal",             message: string }
 *   null
 */
export function detectFreebuffLimit(eventsOrLines) {
  const RATE_LIMIT_STATUSES = new Set(["rate_limited"]);
  const HEADLESS_NOT_READY_STATUSES = new Set(["queued"]);
  const FATAL_STATUSES = new Set([
    "country_blocked",
    "banned",
    "takeover_prompt",
    "model_unavailable",
  ]);
  const RATE_LIMIT_RE = /rate.?limit|quota|too.?many.?session/i;

  for (const raw of toItems(eventsOrLines)) {
    let ev = raw;
    if (typeof raw === "string") {
      const line = raw.trim();
      if (!line.startsWith("{")) continue;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
    }
    if (!ev || typeof ev !== "object") continue;

    if (ev.type === "session.status") {
      const status = typeof ev.status === "string" ? ev.status : null;
      const message =
        typeof ev.message === "string" ? ev.message : (status ?? "unknown");
      if (status && RATE_LIMIT_STATUSES.has(status)) {
        // Rate-limited: retryable, but Freebuff does not surface a reset time.
        return { kind: "rate-limit", message, resetsAt: null };
      }
      if (status && HEADLESS_NOT_READY_STATUSES.has(status)) {
        // Queued: session not yet executing; headless automation cannot wait.
        return { kind: "headless-not-ready", message };
      }
      if (status && FATAL_STATUSES.has(status)) {
        return { kind: "fatal", message };
      }
    }

    if (ev.type === "session.error") {
      // Check error messages for rate-limit keywords even without a status field.
      const message = typeof ev.message === "string" ? ev.message : "";
      if (RATE_LIMIT_RE.test(message)) {
        return { kind: "rate-limit", message, resetsAt: null };
      }
    }
  }

  return null;
}

/** Throwaway smoke: spawn freebuff and print the parsed result. */
async function main() {
  // The preflight probes use real I/O here.
  const { execFileSync } = await import("node:child_process");

  /** Live version probe for the smoke entrypoint. */
  function liveRunVersion(bin) {
    try {
      const out = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
      });
      return { ok: true, version: out.trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const preflight = freebuffPreflight({ runVersion: liveRunVersion });
  process.stderr.write(`\n--- freebuff preflight ---\n`);
  for (const [key, row] of Object.entries(preflight)) {
    process.stderr.write(
      `  ${key}: ${row.ok ? "ok" : "FAIL"} — ${row.detail}\n`
    );
  }

  const prompt = process.argv[2] ?? "Reply with the single word: ok";
  const cwd = process.argv[3] ?? process.cwd();
  const argv = buildFreebuffArgs(".otto-tmp/.probe.md", { cwd });
  // For live smoke, override the last arg with the CLI prompt directly.
  argv[argv.length - 1] = prompt;
  process.stderr.write(`\nspawning: ${argv.join(" ")}\n`);

  await new Promise((resolve) => {
    const lines = [];
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      for (const l of d.toString().split("\n")) if (l.trim()) lines.push(l);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (err) => {
      process.stderr.write(
        `\nSPIKE BLOCKED: failed to spawn freebuff — ${err.message}\n` +
          `  (Expected: freebuff binary not installed or exec subcommand not supported)\n`
      );
      resolve();
    });
    child.on("close", (code) => {
      process.stderr.write(`\nfreebuff exited ${code}\n`);
      const parsed = parseFreebuffEvents(lines);
      const limit = detectFreebuffLimit(lines);
      process.stdout.write(JSON.stringify({ parsed, limit }, null, 2) + "\n");
      resolve();
    });
  });
}

// Only run the smoke when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
