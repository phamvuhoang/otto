// Documentation contract test for the agent-runtime feature (issue #24 P5).
// Issue #24 introduces a provider-neutral agent runtime (Claude default, Codex
// opt-in) selectable via `--agent` / `OTTO_AGENT` / `.otto/config.json`, plus
// provider-specific model env and fallback-on-limit config. P5's requirement is
// that a user can understand "Claude default, Codex opt-in, fallback behavior"
// without reading source, and that no doc claims Otto only runs Claude.
//
// This pins the runtime docs against the REAL source of truth so a runtime id,
// display name, or default change forces a doc edit instead of leaving the docs
// silently stale:
//   - the runtime ids + display names  ← agent-runtime.ts AGENT_DISPLAY_NAMES
//   - the default runtime               ← agent-runtime.ts DEFAULT_AGENT
//   - the flags / env vars              ← cli-help.ts (parsed, not hardcoded here)
// Run via `pnpm test` (node --test). No build / network needed — reads the
// markdown and parses agent-runtime.ts / cli-help.ts directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = (rel) => readFileSync(join(root, rel), "utf8");
const src = (rel) =>
  readFileSync(join(root, "packages", "core", "src", rel), "utf8");

const readme = doc("README.md");
const cli = doc("docs/CLI.md");
const config = doc("docs/CONFIG.md");
const security = doc("SECURITY.md");
const architecture = doc("docs/ARCHITECTURE.md");

const agentRuntimeSrc = src("agent-runtime.ts");
const cliHelpSrc = src("cli-help.ts");

// Parse the runtime id → display-name map out of agent-runtime.ts. This is the
// source of truth `--print-config` and the banners read; parsing it (rather than
// hardcoding {claude, codex} here) means a new runtime forces the docs to grow.
function displayNames(s) {
  const block = s.match(/AGENT_DISPLAY_NAMES[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, "could not locate AGENT_DISPLAY_NAMES in agent-runtime.ts");
  const map = {};
  const entry = /(\w+):\s*"([^"]+)"/g;
  let m;
  while ((m = entry.exec(block[1])) !== null) map[m[1]] = m[2];
  assert.ok(
    Object.keys(map).length >= 2,
    `parsed too few AGENT_DISPLAY_NAMES entries (${Object.keys(map).length})`
  );
  return map;
}

function defaultAgent(s) {
  const m = s.match(/DEFAULT_AGENT[^=]*=\s*"([^"]+)"/);
  assert.ok(m, "could not locate DEFAULT_AGENT in agent-runtime.ts");
  return m[1];
}

const NAMES = displayNames(agentRuntimeSrc);
const IDS = Object.keys(NAMES);
const DEFAULT = defaultAgent(agentRuntimeSrc);

test("CLI.md documents the --agent flag and every runtime id + display name", () => {
  assert.ok(
    cli.includes("--agent"),
    "docs/CLI.md must document the --agent flag"
  );
  for (const id of IDS) {
    assert.ok(cli.includes(id), `docs/CLI.md must name the runtime id "${id}"`);
    assert.ok(
      cli.includes(NAMES[id]),
      `docs/CLI.md must name the display name "${NAMES[id]}"`
    );
  }
});

test("CLI.md documents the fallback flags it actually parses", () => {
  // Only assert flags that genuinely exist in cli-help.ts, so the doc can't
  // claim a flag the CLI doesn't accept (and vice-versa).
  for (const flag of ["--fallback-agent", "--auto-switch-on-limit"]) {
    assert.ok(
      cliHelpSrc.includes(flag),
      `cli-help.ts no longer parses ${flag} — update this contract`
    );
    assert.ok(cli.includes(flag), `docs/CLI.md must document ${flag}`);
  }
});

test("CLI.md documents the flag→env→config→default precedence", () => {
  // The precedence the resolver implements (resolveAgentRuntime). A reader must
  // be able to predict which source wins without reading source.
  const norm = cli.replace(/\s+/g, " ");
  assert.ok(
    /--agent.*OTTO_AGENT.*config.*default/i.test(norm) ||
      /flag.*env.*config.*default/i.test(norm),
    "docs/CLI.md must spell out the --agent → OTTO_AGENT → config → default precedence"
  );
});

test("CONFIG.md documents every runtime env var", () => {
  for (const v of [
    "OTTO_AGENT",
    "OTTO_FALLBACK_AGENT",
    "OTTO_AUTO_SWITCH_ON_LIMIT",
    "OTTO_CLAUDE_MODEL",
    "OTTO_CODEX_MODEL",
  ]) {
    assert.ok(
      cliHelpSrc.includes(v) ||
        agentRuntimeSrc.includes(v) ||
        src("runner.ts").includes(v),
      `no source reads ${v} — update this contract`
    );
    assert.ok(config.includes(v), `docs/CONFIG.md must document ${v}`);
  }
});

test("docs state Claude is the default runtime", () => {
  // Issue #24: existing no-config behavior remains Claude; users do not need to
  // change commands. The default id from source must be named as the default.
  assert.equal(DEFAULT, "claude", "DEFAULT_AGENT drifted from claude");
  const cfgNorm = config.replace(/\s+/g, " ").toLowerCase();
  assert.ok(
    /default[^.]*claude/.test(cfgNorm) || /claude[^.]*default/.test(cfgNorm),
    "docs/CONFIG.md must state Claude is the default runtime"
  );
});

test("README surfaces runtime selection (flag + env)", () => {
  assert.ok(readme.includes("--agent"), "README.md must list the --agent flag");
  assert.ok(
    readme.includes("OTTO_AGENT"),
    "README.md must list the OTTO_AGENT env var"
  );
});

test("SECURITY.md discusses credentials/sandbox for both runtimes", () => {
  // Both runtimes' credential surfaces must be covered (issue #24 P5).
  assert.ok(
    /codex/i.test(security),
    "SECURITY.md must discuss the Codex runtime"
  );
  assert.ok(
    security.includes("~/.codex") || security.includes("OPENAI_API_KEY"),
    "SECURITY.md must name Codex's credential source (~/.codex/auth.json or OPENAI_API_KEY)"
  );
});

test("ARCHITECTURE.md documents the AgentRuntime boundary", () => {
  assert.ok(
    architecture.includes("AgentRuntime"),
    "docs/ARCHITECTURE.md must describe the AgentRuntime abstraction"
  );
  assert.ok(
    architecture.includes("agent-runtime.ts"),
    "docs/ARCHITECTURE.md must point at agent-runtime.ts"
  );
});

test("no doc claims Otto runs only Claude", () => {
  // Acceptance criterion: no doc says Otto only runs Claude once runtime
  // selection ships. Catch the most direct phrasings.
  for (const [name, text] of [
    ["README.md", readme],
    ["docs/CLI.md", cli],
    ["docs/CONFIG.md", config],
  ]) {
    const norm = text.replace(/\s+/g, " ").toLowerCase();
    for (const claim of [
      "only runs claude",
      "only supports claude",
      "claude is the only",
    ]) {
      assert.ok(
        !norm.includes(claim),
        `${name} must not claim Otto "${claim}"`
      );
    }
  }
});
