// Codex CLI adapter SPIKE harness (issue #24, P2 — throwaway, NOT production).
//
// Purpose: prove how Codex CLI (`@openai/codex`) can satisfy Otto's
// non-interactive loop contract, and pin a candidate Codex-event → StageResult
// mapping used by the production Codex adapter.
//
// Why it lives in scripts/ and not packages/core/src/: the repo's P0 learning
// keeps Codex-specific parsing OUT of the runner until the spike reveals the
// signal shape (YAGNI). scripts/ is not in core's package `files`, so nothing
// here ships in the tarball. The production adapter lives in
// packages/core/src/runner.ts + preflight.ts.
//
// The candidate parser/preflight/argv builder below are unit-pinned by
// scripts/codex-spike.test.mjs against sample fixtures. Schemas marked
// "UNVERIFIED" in docs/spikes/codex-runtime-spike.md still need a live-binary
// confirmation — the smoke could not run here (native binary missing; see doc).
//
// Run the smoke manually once a working `codex` is on PATH:
//   node scripts/codex-spike.mjs "summarize the README in one sentence"

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** StageResult-shaped object (mirrors packages/core/src/runner.ts StageResult). */
const emptyUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

function usageNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return 0;
  return Math.floor(value);
}

/**
 * Map a Codex `exec --json` event stream into Otto's StageResult shape.
 *
 * Candidate mapping for the thread/item event model emitted by recent
 * `codex exec --json` (Codex 0.x):
 *   - result   ← text of the last `item.completed` agent_message item.
 *   - usage    ← `turn.completed.usage` (input/cached_input/output tokens).
 *   - costUsd  ← 0. Codex emits TOKEN COUNTS, not a USD total like Claude's
 *                `total_cost_usd`; deriving cost is still a gap (tokens × pricing).
 *   - isError / apiErrorStatus ← from a `turn.failed`/`error` event; the message
 *                is carried so isLimitResult()'s regex can classify rate limits.
 *
 * Accepts either an array of already-parsed events or an array of raw JSONL
 * lines (strings are JSON.parsed; non-JSON lines are ignored, mirroring the
 * runner's `if (!line.startsWith("{")) return`).
 */
export function parseCodexEvents(eventsOrLines) {
  let result = "";
  let isError = false;
  let apiErrorStatus = null;
  let usage = emptyUsage();

  for (const raw of eventsOrLines) {
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
    if (type === "item.completed" && ev.item && typeof ev.item === "object") {
      const item = ev.item;
      // The assistant's final prose is an `agent_message` item; tolerate a bare
      // `.text` for forward-compat with renamed item kinds.
      if (
        (item.type === "agent_message" || typeof item.text === "string") &&
        typeof item.text === "string"
      ) {
        result = item.text;
      }
    } else if (type === "turn.completed" && ev.usage) {
      const u = ev.usage;
      usage = {
        inputTokens: usageNumber(u.input_tokens),
        outputTokens: usageNumber(u.output_tokens),
        // Codex reports cached input tokens but has no cache-CREATION concept
        // the way Claude does → that field stays 0 (documented gap).
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: usageNumber(u.cached_input_tokens),
      };
    } else if (type === "turn.failed" || type === "error") {
      isError = true;
      const msg =
        (ev.error && typeof ev.error.message === "string"
          ? ev.error.message
          : null) ?? (typeof ev.message === "string" ? ev.message : null);
      if (msg) apiErrorStatus = msg;
    }
  }

  return {
    result,
    costUsd: 0,
    isError,
    apiErrorStatus,
    usage,
    runtimeId: "codex",
  };
}

/**
 * Detect a Codex rate/usage limit from the event stream. Returns
 * `{ message, resetsAt }` or null. `resetsAt` is unix-seconds when Codex
 * surfaces one (opportunistically read from `error.resets_in_seconds` /
 * a `rate_limits.resets_at`), else null — the exact field is a documented
 * UNVERIFIED gap until a live limit is captured.
 */
export function detectCodexRateLimit(eventsOrLines, nowSeconds = 0) {
  const re = /rate.?limit|usage limit|quota|too many requests|\b429\b/i;
  for (const raw of eventsOrLines) {
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
    if (ev.type !== "turn.failed" && ev.type !== "error") continue;
    const err = ev.error && typeof ev.error === "object" ? ev.error : ev;
    const message =
      typeof err.message === "string"
        ? err.message
        : typeof ev.message === "string"
          ? ev.message
          : "";
    if (!re.test(message)) continue;
    let resetsAt = null;
    if (typeof err.resets_in_seconds === "number") {
      resetsAt = nowSeconds + err.resets_in_seconds;
    } else if (typeof err.resets_at === "number") {
      resetsAt = err.resets_at;
    }
    return { message, resetsAt };
  }
  return null;
}

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
 * Candidate Codex preflight: detect the CLI on PATH and an auth source
 * distinctly (Codex stores ChatGPT login at ~/.codex/auth.json, accepts
 * CODEX_API_KEY for `codex exec`, and Otto maps OPENAI_API_KEY as a
 * compatibility source). Returns two PreflightResult-shaped rows.
 */
export function codexPreflight(probes = {}) {
  const {
    resolveBin = (n) => whichBin(n),
    pathExists = existsSync,
    home = homedir(),
    env = process.env,
  } = probes;

  const cli = resolveBin("codex");
  const authFile = pathExists(join(home, ".codex", "auth.json"));
  const codexKey =
    typeof env.CODEX_API_KEY === "string" && env.CODEX_API_KEY !== "";
  const openAiKey =
    typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY !== "";
  const authed = authFile || codexKey || openAiKey;

  return {
    cli: {
      label: "codex CLI",
      ok: cli != null,
      detail: cli ?? "not found on PATH — install @openai/codex",
    },
    auth: {
      label: "codex auth",
      ok: authed,
      detail: authed
        ? authFile
          ? "credentials found (~/.codex/auth.json)"
          : codexKey
            ? "credentials found (CODEX_API_KEY)"
            : "credentials found (OPENAI_API_KEY; mapped to CODEX_API_KEY)"
        : "run `codex login` or set CODEX_API_KEY (OPENAI_API_KEY also accepted)",
    },
  };
}

/**
 * Candidate argv for a non-interactive Codex stage. Mirrors buildClaudeArgs:
 * starts with the command, ends with the prompt instruction. Non-interactive
 * automation needs the sandbox + never-approve flags Codex requires (Claude's
 * `--permission-mode bypassPermissions` has no 1:1 Codex equivalent — the pair
 * `--sandbox <mode> --ask-for-approval never` is the closest, see findings).
 */
export function buildCodexArgs(
  promptRelPath,
  modelArgs = [],
  sandboxMode = "workspace-write"
) {
  return [
    "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    sandboxMode,
    "--ask-for-approval",
    "never",
    ...modelArgs,
    `Read the full instructions from the file ./${promptRelPath} in the current workspace and execute them.`,
  ];
}

/** Throwaway smoke: spawn codex against a prompt and print the parsed result. */
async function main() {
  const prompt = process.argv[2] ?? "Reply with the single word: ok";
  const argv = [
    "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    prompt,
  ];
  process.stderr.write(`spawning: ${argv.join(" ")}\n`);

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
        `\nSPIKE BLOCKED: failed to spawn codex — ${err.message}\n`
      );
      resolve();
    });
    child.on("close", (code) => {
      process.stderr.write(`\ncodex exited ${code}\n`);
      const parsed = parseCodexEvents(lines);
      const limit = detectCodexRateLimit(lines);
      process.stdout.write(JSON.stringify({ parsed, limit }, null, 2) + "\n");
      resolve();
    });
  });
}

// Only run the smoke when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
