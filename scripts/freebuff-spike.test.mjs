// Tests for the Freebuff CLI adapter SPIKE harness (Phase 0). Pins the
// candidate Freebuff-event → StageResult mapping, limit/session-state detection,
// preflight checks, and argv builder against sample fixtures.
//
// Run via `pnpm test` (node --test, auto-globbed) or directly:
//   node --test scripts/freebuff-spike.test.mjs
//
// No build / network / real freebuff binary required.
// All behavior is pinned from in-file fixtures and injected probe fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFreebuffEvents,
  detectFreebuffLimit,
  freebuffPreflight,
  buildFreebuffArgs,
  finalizeFreebuffResult,
} from "./freebuff-spike.mjs";

// ---------------------------------------------------------------------------
// Candidate fixtures (UNVERIFIED -- hypothetical `freebuff exec --json` output)
// ---------------------------------------------------------------------------

// A successful Freebuff stage run: session goes active, task completes.
const SUCCESS_STREAM = [
  { type: "session.status", status: "active" },
  { type: "task.completed", output: "Done: README summarized." },
];

// A terminal error stream: session error with a message.
const ERROR_STREAM = [
  { type: "session.status", status: "active" },
  { type: "session.error", message: "task execution failed", status: "ended" },
];

// ---------------------------------------------------------------------------
// parseFreebuffEvents
// ---------------------------------------------------------------------------

test("parseFreebuffEvents maps a completed event to StageResult shape", () => {
  const r = parseFreebuffEvents(SUCCESS_STREAM);
  assert.equal(r.result, "Done: README summarized.");
  assert.equal(r.runtimeId, "freebuff");
  assert.equal(r.isError, false);
  assert.equal(r.apiErrorStatus, null);
  // Freebuff does not expose token counts or USD cost — both default to zero/empty.
  assert.equal(r.costUsd, 0);
  assert.deepEqual(r.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
});

test("parseFreebuffEvents accepts raw JSONL line strings and ignores non-JSON noise", () => {
  const lines = [
    "freebuff starting...", // non-JSON noise
    ...SUCCESS_STREAM.map((e) => JSON.stringify(e)),
    "", // blank line
  ];
  const r = parseFreebuffEvents(lines);
  assert.equal(r.result, "Done: README summarized.");
  assert.equal(r.runtimeId, "freebuff");
  assert.equal(r.isError, false);
});

test("parseFreebuffEvents accepts a single newline-delimited JSONL string", () => {
  const str = SUCCESS_STREAM.map((e) => JSON.stringify(e)).join("\n");
  const r = parseFreebuffEvents(str);
  assert.equal(r.result, "Done: README summarized.");
  assert.equal(r.runtimeId, "freebuff");
  assert.equal(r.isError, false);
});

test("parseFreebuffEvents flags a session.error event with isError and apiErrorStatus", () => {
  const r = parseFreebuffEvents(ERROR_STREAM);
  assert.equal(r.isError, true);
  assert.equal(r.apiErrorStatus, "task execution failed");
  assert.equal(r.result, "");
});

test("parseFreebuffEvents flags terminal session.status as isError", () => {
  const r = parseFreebuffEvents([
    {
      type: "session.status",
      status: "country_blocked",
      message: "not available in your region",
    },
  ]);
  assert.equal(r.isError, true);
  assert.equal(r.apiErrorStatus, "not available in your region");
});

// ---------------------------------------------------------------------------
// detectFreebuffLimit
// ---------------------------------------------------------------------------

test("detectFreebuffLimit returns null for a normal completed stream", () => {
  assert.equal(detectFreebuffLimit(SUCCESS_STREAM), null);
});

test("detectFreebuffLimit classifies rate_limited → rate_limit with null reset", () => {
  const hit = detectFreebuffLimit([
    {
      type: "session.status",
      status: "rate_limited",
      message: "too many sessions",
    },
  ]);
  assert.ok(hit, "expected a limit result for rate_limited");
  assert.equal(hit.kind, "rate-limit");
  assert.equal(hit.message, "too many sessions");
  // Freebuff does not expose a reset time — resetsAt is always null (documented gap).
  assert.equal(hit.resetsAt, null);
});

test("detectFreebuffLimit classifies queued → headless-not-ready", () => {
  const hit = detectFreebuffLimit([
    {
      type: "session.status",
      status: "queued",
      message: "waiting for an available session",
    },
  ]);
  assert.ok(hit, "expected a limit result for queued");
  assert.equal(hit.kind, "headless-not-ready");
});

test("detectFreebuffLimit classifies country_blocked, banned, model_unavailable, takeover_prompt → fatal", () => {
  for (const status of [
    "country_blocked",
    "banned",
    "model_unavailable",
    "takeover_prompt",
  ]) {
    const hit = detectFreebuffLimit([
      { type: "session.status", status, message: `session ${status}` },
    ]);
    assert.ok(hit, `expected a limit result for status: ${status}`);
    assert.equal(hit.kind, "fatal", `expected fatal for status: ${status}`);
  }
});

test("detectFreebuffLimit detects rate-limit keywords in session.error messages", () => {
  const hit = detectFreebuffLimit([
    { type: "session.error", message: "quota exceeded for this account" },
  ]);
  assert.ok(hit, "expected a limit result for quota message");
  assert.equal(hit.kind, "rate-limit");
  assert.equal(hit.resetsAt, null);
});

test("detectFreebuffLimit accepts a newline-delimited JSONL string input", () => {
  const str = JSON.stringify({
    type: "session.status",
    status: "rate_limited",
  });
  const hit = detectFreebuffLimit(str);
  assert.ok(hit);
  assert.equal(hit.kind, "rate-limit");
});

// ---------------------------------------------------------------------------
// freebuffPreflight
// ---------------------------------------------------------------------------

test("freebuffPreflight reports all checks ready when binary, version, and credentials present", () => {
  const full = freebuffPreflight({
    resolveBin: () => "/usr/local/bin/freebuff",
    runVersion: () => ({ ok: true, version: "1.2.3" }),
    pathExists: () => true,
    home: "/home/u",
    env: {},
  });
  assert.equal(full.cli.ok, true);
  assert.equal(full.version.ok, true);
  assert.match(full.version.detail, /1\.2\.3/);
  assert.equal(full.auth.ok, true);
  assert.match(full.auth.detail, /credentials\.json/);
});

test("freebuffPreflight reports cli not ready when binary missing", () => {
  const noCli = freebuffPreflight({
    resolveBin: () => null,
    runVersion: () => ({ ok: true, version: "1.0.0" }),
    pathExists: () => false,
    home: "/home/u",
    env: {},
  });
  assert.equal(noCli.cli.ok, false);
  assert.match(noCli.cli.detail, /not found/);
});

test("freebuffPreflight reports version not ready when probe fails though PATH resolves", () => {
  const versionFail = freebuffPreflight({
    resolveBin: () => "/usr/local/bin/freebuff",
    runVersion: () => ({
      ok: false,
      error: "native binary missing or corrupt",
    }),
    pathExists: () => true,
    home: "/home/u",
    env: {},
  });
  assert.equal(versionFail.cli.ok, true); // PATH resolved fine
  assert.equal(versionFail.version.ok, false); // but version probe failed
  assert.match(versionFail.version.detail, /launcher\/binary mismatch/);
});

test("freebuffPreflight reports auth not ready with remediation when credentials missing", () => {
  const noAuth = freebuffPreflight({
    resolveBin: () => "/usr/local/bin/freebuff",
    runVersion: () => ({ ok: true, version: "1.0.0" }),
    pathExists: () => false,
    home: "/home/u",
    env: {},
  });
  assert.equal(noAuth.auth.ok, false);
  // Remediation should mention CODEBUFF_API_KEY (the env alternative).
  assert.match(noAuth.auth.detail, /CODEBUFF_API_KEY/);
});

test("freebuffPreflight detects credentials via CODEBUFF_API_KEY env when no file", () => {
  const viaEnv = freebuffPreflight({
    resolveBin: () => "/usr/local/bin/freebuff",
    runVersion: () => ({ ok: true, version: "1.0.0" }),
    pathExists: () => false,
    home: "/home/u",
    env: { CODEBUFF_API_KEY: "cb-test-key" },
  });
  assert.equal(viaEnv.auth.ok, true);
  assert.match(viaEnv.auth.detail, /CODEBUFF_API_KEY/);
});

test("freebuffPreflight reports version.ok as null (not false) when runVersion probe is not injected", () => {
  const noProbe = freebuffPreflight({
    resolveBin: () => "/usr/local/bin/freebuff",
    // runVersion intentionally omitted — simulates the not-probed path.
    pathExists: () => true,
    home: "/home/u",
    env: {},
  });
  assert.equal(noProbe.cli.ok, true); // binary found
  assert.equal(noProbe.version.ok, null); // not probed — must not be false
  assert.match(noProbe.version.detail, /not probed/);
});

// ---------------------------------------------------------------------------
// buildFreebuffArgs
// ---------------------------------------------------------------------------

test("buildFreebuffArgs emits preferred headless candidate argv with cwd and prompt instruction", () => {
  const argv = buildFreebuffArgs(".otto-tmp/.run-1.md", { cwd: "/workspace" });
  assert.equal(argv[0], "freebuff");
  assert.equal(argv[1], "exec");
  assert.ok(
    argv.includes("--json"),
    "should include --json for machine-readable output"
  );
  assert.ok(argv.includes("--cwd"), "should include --cwd flag");
  assert.ok(argv.includes("/workspace"), "should include the cwd value");
  // Last arg should reference the prompt file path.
  assert.match(argv[argv.length - 1], /\.otto-tmp\/\.run-1\.md/);
});

test("buildFreebuffArgs does not emit Claude-only or Codex-only flags", () => {
  const argv = buildFreebuffArgs(".otto-tmp/.run-1.md", { cwd: "." });
  // Claude-only flags.
  assert.ok(
    !argv.includes("--settings"),
    "must not include --settings (Claude-only)"
  );
  assert.ok(
    !argv.includes("--permission-mode"),
    "must not include --permission-mode (Claude-only)"
  );
  // Codex-only flags.
  assert.ok(
    !argv.includes("--ask-for-approval"),
    "must not include --ask-for-approval (Codex-only)"
  );
  assert.ok(
    !argv.includes("--sandbox"),
    "must not include --sandbox (Codex-only)"
  );
  assert.ok(
    !argv.includes("--ignore-user-config"),
    "must not include --ignore-user-config (Codex-only)"
  );
  assert.ok(
    !argv.includes("--skip-git-repo-check"),
    "must not include --skip-git-repo-check (Codex-only)"
  );
});

test("buildFreebuffArgs uses cwd default of '.' when opts omitted", () => {
  const argv = buildFreebuffArgs("prompt.md");
  assert.ok(argv.includes("."), "default cwd should be '.'");
});

// finalizeFreebuffResult: fold the child process exit code + stderr into the
// parsed result. Surfaced by the live smoke against freebuff v0.0.115, where
// `freebuff exec --json` exits 1 with an error on stderr and no stdout events,
// yet parseFreebuffEvents alone returns isError:false (it never saw the exit).

test("finalizeFreebuffResult flags non-zero exit with no events as an error", () => {
  const parsed = parseFreebuffEvents([]); // empty stdout → isError:false
  const final = finalizeFreebuffResult(parsed, {
    code: 1,
    stderr: "error: unknown option '--json'\n",
  });
  assert.equal(final.isError, true);
  assert.match(final.apiErrorStatus, /unknown option '--json'/);
  assert.equal(final.runtimeId, "freebuff");
});

test("finalizeFreebuffResult leaves a clean zero-exit completion untouched", () => {
  const parsed = parseFreebuffEvents([
    { type: "task.completed", output: "ok" },
  ]);
  const final = finalizeFreebuffResult(parsed, { code: 0, stderr: "" });
  assert.equal(final.isError, false);
  assert.equal(final.apiErrorStatus, null);
  assert.equal(final.result, "ok");
});

test("finalizeFreebuffResult preserves a parser-detected error on non-zero exit", () => {
  const parsed = parseFreebuffEvents([
    { type: "session.error", message: "rate limited", status: "rate_limited" },
  ]);
  const final = finalizeFreebuffResult(parsed, { code: 1, stderr: "noise" });
  assert.equal(final.isError, true);
  // The richer parser-supplied status wins over a generic stderr fallback.
  assert.equal(final.apiErrorStatus, "rate limited");
});
