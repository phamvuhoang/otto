// Tests for the Codex CLI adapter SPIKE harness (issue #24, P2). Pins the
// candidate Codex-event → StageResult mapping, rate-limit detection, preflight
// detection, and argv builder against sample fixtures. Run via `pnpm test`
// (node --test, auto-globbed).
// No build / network / real codex binary needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCodexEvents,
  detectCodexRateLimit,
  codexPreflight,
  buildCodexArgs,
} from "./codex-spike.mjs";

// A sample `codex exec --json` thread/item event stream (one successful turn).
const SUCCESS_STREAM = [
  { type: "thread.started", thread_id: "th_123" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "i_1", type: "command_execution", command: "ls" },
  },
  {
    type: "item.completed",
    item: {
      id: "i_2",
      type: "agent_message",
      text: "Done: README summarized.",
    },
  },
  {
    type: "turn.completed",
    usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80 },
  },
];

test("parseCodexEvents maps a successful turn to StageResult", () => {
  const r = parseCodexEvents(SUCCESS_STREAM);
  assert.equal(r.result, "Done: README summarized.");
  assert.equal(r.runtimeId, "codex");
  assert.equal(r.isError, false);
  assert.equal(r.apiErrorStatus, null);
  // Codex emits token counts, not a USD cost — costUsd stays 0 (documented gap).
  assert.equal(r.costUsd, 0);
  assert.deepEqual(r.usage, {
    inputTokens: 1200,
    outputTokens: 80,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 300,
  });
});

test("parseCodexEvents accepts raw JSONL lines and ignores non-JSON noise", () => {
  const lines = [
    "warning: experimental json",
    ...SUCCESS_STREAM.map((e) => JSON.stringify(e)),
    "",
  ];
  const r = parseCodexEvents(lines);
  assert.equal(r.result, "Done: README summarized.");
  assert.equal(r.usage.inputTokens, 1200);
});

test("parseCodexEvents flags a failed turn with its message", () => {
  const r = parseCodexEvents([
    { type: "turn.started" },
    { type: "turn.failed", error: { message: "model overloaded" } },
  ]);
  assert.equal(r.isError, true);
  assert.equal(r.apiErrorStatus, "model overloaded");
  assert.equal(r.result, "");
});

test("detectCodexRateLimit detects a rate-limit failure, null otherwise", () => {
  assert.equal(detectCodexRateLimit(SUCCESS_STREAM), null);

  const hit = detectCodexRateLimit(
    [
      {
        type: "turn.failed",
        error: { message: "429 rate limit exceeded", resets_in_seconds: 120 },
      },
    ],
    1000
  );
  assert.ok(hit);
  assert.match(hit.message, /rate limit/i);
  assert.equal(hit.resetsAt, 1120);

  // No reset hint → resetsAt null (UNVERIFIED field shape, documented gap).
  const noReset = detectCodexRateLimit([
    { type: "error", message: "usage limit reached" },
  ]);
  assert.ok(noReset);
  assert.equal(noReset.resetsAt, null);
});

test("codexPreflight detects CLI + auth distinctly", () => {
  // CLI + auth.json present.
  const full = codexPreflight({
    resolveBin: () => "/usr/local/bin/codex",
    pathExists: () => true,
    home: "/home/u",
    env: {},
  });
  assert.equal(full.cli.ok, true);
  assert.equal(full.auth.ok, true);
  assert.match(full.auth.detail, /auth\.json/);

  // CLI missing.
  const noCli = codexPreflight({
    resolveBin: () => null,
    pathExists: () => false,
    home: "/home/u",
    env: {},
  });
  assert.equal(noCli.cli.ok, false);
  assert.match(noCli.cli.detail, /not found/);

  // Auth via CODEX_API_KEY when no auth.json.
  const viaCodexEnv = codexPreflight({
    resolveBin: () => "/usr/local/bin/codex",
    pathExists: () => false,
    home: "/home/u",
    env: { CODEX_API_KEY: "sk-test" },
  });
  assert.equal(viaCodexEnv.auth.ok, true);
  assert.match(viaCodexEnv.auth.detail, /CODEX_API_KEY/);

  // Auth via OPENAI_API_KEY compatibility when no auth.json.
  const viaEnv = codexPreflight({
    resolveBin: () => "/usr/local/bin/codex",
    pathExists: () => false,
    home: "/home/u",
    env: { OPENAI_API_KEY: "sk-test" },
  });
  assert.equal(viaEnv.auth.ok, true);
  assert.match(viaEnv.auth.detail, /OPENAI_API_KEY/);
  assert.match(viaEnv.auth.detail, /CODEX_API_KEY/);

  // No auth at all.
  const noAuth = codexPreflight({
    resolveBin: () => "/usr/local/bin/codex",
    pathExists: () => false,
    home: "/home/u",
    env: {},
  });
  assert.equal(noAuth.auth.ok, false);
  assert.match(noAuth.auth.detail, /codex login/);
});

test("buildCodexArgs builds a non-interactive argv ending in the prompt", () => {
  const argv = buildCodexArgs(".otto-tmp/.run-1.md", ["--model", "o3"]);
  assert.equal(argv[0], "codex");
  assert.equal(argv[1], "exec");
  assert.ok(argv.includes("--json"));
  assert.ok(argv.includes("--skip-git-repo-check"));
  // Non-interactive needs sandbox + never-approve (no claude bypassPermissions 1:1).
  assert.ok(argv.includes("--sandbox"));
  assert.ok(argv.includes("workspace-write"));
  const ai = argv.indexOf("--ask-for-approval");
  assert.equal(argv[ai + 1], "never");
  assert.ok(argv.includes("--model"));
  assert.ok(argv.includes("o3"));
  assert.match(
    argv[argv.length - 1],
    /Read the full instructions from the file \.\/\.otto-tmp\/\.run-1\.md/
  );
});
