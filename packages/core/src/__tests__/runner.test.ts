import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleUi, VerboseSink, type EventSink } from "../console-ui.js";
import type { StreamJson } from "../stream-render.js";
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildCodexEnv,
  buildReviewChildEnv,
  buildSandboxSettings,
  claudeRuntime,
  codexRuntime,
  createCodexStreamParser,
  getAgentRuntime,
  parseGraceMs,
  resetsAtFromCodexEvent,
  resolveChildEnv,
  resolveCodexSandboxMode,
  resolveModelArgs,
  resolveModelSelection,
  resolveRunner,
  resolveSandboxNet,
  resultFromEvent,
  stageAccess,
  stageLogPath,
} from "../runner.js";
import { devNull } from "node:os";

// The stream loop resolves `options.sink ?? new VerboseSink()` once and calls
// `sink.onEvent(parsed)` per non-codex event (issue #65 P10). streamRuntime is
// internal and spawns a child, so we assert the injected-sink contract it relies
// on rather than re-spawning a process here.
describe("runStage sink injection contract", () => {
  afterEach(() => vi.restoreAllMocks());

  const resolveSink = (sink?: EventSink): EventSink =>
    sink ?? new VerboseSink();

  it("falls back to a VerboseSink when no sink is provided", () => {
    expect(resolveSink()).toBeInstanceOf(VerboseSink);
  });

  it("uses the provided sink, forwarding each event to onEvent", () => {
    const sink: EventSink = { setStage: vi.fn(), onEvent: vi.fn() };
    const resolved = resolveSink(sink);
    expect(resolved).toBe(sink);
    const ev = { type: "result", is_error: false } as StreamJson;
    resolved.onEvent(ev);
    expect(sink.onEvent).toHaveBeenCalledWith(ev);
  });

  it("the default VerboseSink renders an assistant text block to stdout", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    resolveSink().onEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "rendered" }] },
    } as StreamJson);
    expect(write.mock.calls.map((c) => String(c[0])).join("")).toMatch(
      /rendered/
    );
  });

  it("a ConsoleUi sink stays quiet on an assistant text block", () => {
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    resolveSink(new ConsoleUi()).onEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "quiet" }] },
    } as StreamJson);
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});

describe("parseGraceMs", () => {
  it("returns the default when unset", () => {
    expect(parseGraceMs(undefined)).toBe(30_000);
  });

  it("returns the default for an empty string", () => {
    expect(parseGraceMs("")).toBe(30_000);
  });

  it("returns the default for whitespace-only input", () => {
    expect(parseGraceMs("   ")).toBe(30_000);
  });

  it("returns the default for non-numeric input", () => {
    expect(parseGraceMs("abc")).toBe(30_000);
  });

  it("returns the default for negative input", () => {
    expect(parseGraceMs("-5")).toBe(30_000);
  });

  it("returns 0 when explicitly set to 0 (disabled)", () => {
    expect(parseGraceMs("0")).toBe(0);
  });

  it("returns the parsed value for a valid integer", () => {
    expect(parseGraceMs("45000")).toBe(45_000);
  });

  it("floors fractional values", () => {
    expect(parseGraceMs("1500.9")).toBe(1500);
  });

  it("honors a custom default", () => {
    expect(parseGraceMs(undefined, 1000)).toBe(1000);
    expect(parseGraceMs("abc", 1000)).toBe(1000);
  });
});

describe("stageLogPath", () => {
  it("appends the runtime id as a filename suffix when given", () => {
    const p = stageLogPath("/ws", 2, "implementer", "codex");
    expect(p).toMatch(/-iter2-implementer-codex\.ndjson$/);
  });

  it("omits the suffix when no runtime id is given (back-compat)", () => {
    const p = stageLogPath("/ws", 2, "implementer");
    expect(p).toMatch(/-iter2-implementer\.ndjson$/);
    expect(p).not.toContain("-claude");
  });
});

describe("resolveModelArgs", () => {
  it("returns [] when unset", () => {
    expect(resolveModelArgs(undefined)).toEqual([]);
  });

  it("returns [] for an empty string", () => {
    expect(resolveModelArgs("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(resolveModelArgs("   ")).toEqual([]);
  });

  it("returns --model + alias for a short alias", () => {
    expect(resolveModelArgs("opus")).toEqual(["--model", "opus"]);
  });

  it("returns --model + full id for a full model spec", () => {
    expect(resolveModelArgs("claude-opus-4-8")).toEqual([
      "--model",
      "claude-opus-4-8",
    ]);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveModelArgs("  opus  ")).toEqual(["--model", "opus"]);
  });
});

describe("resolveModelSelection", () => {
  it("returns undefined when neither generic nor provider-specific is set", () => {
    expect(resolveModelSelection("claude", {})).toBeUndefined();
  });

  it("falls back to OTTO_MODEL when no provider-specific override is set", () => {
    expect(resolveModelSelection("claude", { OTTO_MODEL: "opus" })).toEqual({
      spec: "opus",
      source: "OTTO_MODEL",
    });
  });

  it("prefers OTTO_CLAUDE_MODEL over OTTO_MODEL for the claude runtime", () => {
    expect(
      resolveModelSelection("claude", {
        OTTO_MODEL: "opus",
        OTTO_CLAUDE_MODEL: "sonnet",
      })
    ).toEqual({ spec: "sonnet", source: "OTTO_CLAUDE_MODEL" });
  });

  it("prefers OTTO_CODEX_MODEL over OTTO_MODEL for the codex runtime", () => {
    expect(
      resolveModelSelection("codex", {
        OTTO_MODEL: "opus",
        OTTO_CODEX_MODEL: "gpt-5",
      })
    ).toEqual({ spec: "gpt-5", source: "OTTO_CODEX_MODEL" });
  });

  it("does not let one runtime's override leak into another", () => {
    expect(
      resolveModelSelection("codex", {
        OTTO_MODEL: "opus",
        OTTO_CLAUDE_MODEL: "sonnet",
      })
    ).toEqual({ spec: "opus", source: "OTTO_MODEL" });
  });

  it("ignores an empty/whitespace provider-specific override and falls back", () => {
    expect(
      resolveModelSelection("codex", {
        OTTO_MODEL: "opus",
        OTTO_CODEX_MODEL: "   ",
      })
    ).toEqual({ spec: "opus", source: "OTTO_MODEL" });
  });

  it("trims the resolved spec", () => {
    expect(
      resolveModelSelection("codex", { OTTO_CODEX_MODEL: "  gpt-5  " })
    ).toEqual({ spec: "gpt-5", source: "OTTO_CODEX_MODEL" });
  });
});

describe("resolveRunner", () => {
  it("defaults to sandbox when unset", () => {
    expect(resolveRunner(undefined)).toBe("sandbox");
  });
  it("defaults to sandbox for empty / unknown values", () => {
    expect(resolveRunner("")).toBe("sandbox");
    expect(resolveRunner("docker")).toBe("sandbox");
  });
  it("selects host only for the literal 'host'", () => {
    expect(resolveRunner("host")).toBe("host");
    expect(resolveRunner("  host  ")).toBe("host");
  });
});

describe("resolveCodexSandboxMode", () => {
  it("defaults Codex to workspace-write", () => {
    expect(resolveCodexSandboxMode(undefined)).toBe("workspace-write");
    expect(resolveCodexSandboxMode("sandbox")).toBe("workspace-write");
    expect(resolveCodexSandboxMode("weird")).toBe("workspace-write");
  });

  it("maps OTTO_RUNNER=host to Codex danger-full-access", () => {
    expect(resolveCodexSandboxMode("host")).toBe("danger-full-access");
  });
});

describe("resolveSandboxNet", () => {
  it("returns [] when unset or empty", () => {
    expect(resolveSandboxNet(undefined)).toEqual([]);
    expect(resolveSandboxNet("   ")).toEqual([]);
  });
  it("splits, trims, and drops empties", () => {
    expect(resolveSandboxNet("github.com, api.anthropic.com,")).toEqual([
      "github.com",
      "api.anthropic.com",
    ]);
  });
});

describe("buildSandboxSettings", () => {
  it("confines writes to the workspace, excludes Go-TLS CLIs, omits network when no domains", () => {
    expect(buildSandboxSettings("/ws", [])).toEqual({
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: ["/ws"] },
        excludedCommands: ["gh *", "gcloud *", "terraform *"],
      },
    });
  });
  it("adds an allowedDomains network block when domains are given", () => {
    expect(buildSandboxSettings("/ws", ["github.com"])).toEqual({
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: ["/ws"] },
        excludedCommands: ["gh *", "gcloud *", "terraform *"],
        network: { allowedDomains: ["github.com"] },
      },
    });
  });
  it("appends extra write roots so a fan-out sub-agent can reach the shared .git", () => {
    expect(
      buildSandboxSettings("/ws/.otto-tmp/wt/t1", [], ["/ws"]).sandbox
    ).toMatchObject({
      filesystem: { allowWrite: ["/ws/.otto-tmp/wt/t1", "/ws"] },
    });
  });
});

describe("resultFromEvent", () => {
  it("extracts result/cost/error fields from a result event", () => {
    expect(
      resultFromEvent({
        type: "result",
        result: "done",
        total_cost_usd: 0.39,
        is_error: false,
        api_error_status: null,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      })
    ).toEqual({
      result: "done",
      costUsd: 0.39,
      isError: false,
      apiErrorStatus: null,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
      },
      runtimeId: "claude",
    });
  });
  it("defaults missing fields safely", () => {
    expect(resultFromEvent({})).toEqual({
      result: "",
      costUsd: 0,
      isError: false,
      apiErrorStatus: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      runtimeId: "claude",
    });
  });
  it("captures an error status string", () => {
    expect(
      resultFromEvent({ is_error: true, api_error_status: "429" })
    ).toMatchObject({
      isError: true,
      apiErrorStatus: "429",
    });
  });
  it("stamps the producing runtime id (defaults to claude)", () => {
    expect(resultFromEvent({}).runtimeId).toBe("claude");
    expect(resultFromEvent({}, "codex").runtimeId).toBe("codex");
  });
});

describe("getAgentRuntime", () => {
  it("returns the claude adapter for the claude id", () => {
    const rt = getAgentRuntime("claude");
    expect(rt).toBe(claudeRuntime);
    expect(rt.id).toBe("claude");
    expect(rt.displayName).toBe("Claude Code");
    expect(rt.command).toBe("claude");
    expect(rt.supportsSandboxSettings).toBe(true);
  });

  it("returns the codex adapter for the codex id", () => {
    const rt = getAgentRuntime("codex");
    expect(rt).toBe(codexRuntime);
    expect(rt.id).toBe("codex");
    expect(rt.displayName).toBe("Codex CLI");
    expect(rt.command).toBe("codex");
    expect(rt.supportsSandboxSettings).toBe(false);
  });
});

describe("claudeRuntime adapter", () => {
  const stage = { name: "test", template: "test.md" };
  const promptPath = ".otto-tmp/prompt.md";

  it("buildArgs matches buildClaudeArgs (claude invocation, byte-for-byte)", () => {
    expect(
      claudeRuntime.buildArgs(stage, promptPath, [], "/ws/s.json")
    ).toEqual(buildClaudeArgs(stage, promptPath, [], "/ws/s.json"));
  });

  it("parseResultEvent stamps runtimeId claude alongside the parsed fields", () => {
    const r = claudeRuntime.parseResultEvent({
      type: "result",
      result: "done",
      total_cost_usd: 0.2,
      is_error: false,
    });
    expect(r.runtimeId).toBe("claude");
    expect(r.result).toBe("done");
    expect(r.costUsd).toBe(0.2);
  });
});

describe("buildClaudeArgs", () => {
  const stage = { name: "test", template: "test.md" };
  const stageWithPermissionMode = {
    name: "test",
    template: "test.md",
    permissionMode: "bypassPermissions",
  };
  const promptPath = ".otto-tmp/prompt.md";

  it("includes the claude invocation and prompt instruction", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args[0]).toBe("claude");
    expect(args).toContain("--verbose");
    expect(args).toContain("--print");
    expect(args.at(-1)).toContain(promptPath);
  });

  it("appends --model args when OTTO_MODEL is set", () => {
    const args = buildClaudeArgs(stage, promptPath, ["--model", "opus"]);
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("opus");
  });

  it("does not include --model when modelArgs is empty", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--model");
  });

  it("includes --permission-mode when stage has permissionMode", () => {
    const args = buildClaudeArgs(stageWithPermissionMode, promptPath, []);
    expect(args).toContain("--permission-mode");
    const idx = args.indexOf("--permission-mode");
    expect(args[idx + 1]).toBe("bypassPermissions");
  });

  it("omits --permission-mode when stage has no permissionMode", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--permission-mode");
  });

  it("places --model args before the prompt instruction", () => {
    const args = buildClaudeArgs(stage, promptPath, ["--model", "opus"]);
    const modelIdx = args.indexOf("--model");
    const promptIdx = args.findIndex((a) => a.includes(promptPath));
    expect(modelIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeLessThan(promptIdx);
  });

  it("injects --settings before the prompt when a settings path is given", () => {
    const args = buildClaudeArgs(stage, promptPath, [], "/ws/.otto-tmp/s.json");
    const sIdx = args.indexOf("--settings");
    expect(sIdx).toBeGreaterThan(-1);
    expect(args[sIdx + 1]).toBe("/ws/.otto-tmp/s.json");
    const promptIdx = args.findIndex((a) => a.includes(promptPath));
    expect(sIdx).toBeLessThan(promptIdx);
  });

  it("omits --settings when no settings path is given", () => {
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).not.toContain("--settings");
  });
});

describe("codexRuntime adapter", () => {
  const stage = { name: "test", template: "test.md" };
  const promptPath = ".otto-tmp/prompt.md";

  it("builds a non-interactive codex exec argv without Claude-only flags", () => {
    const args = buildCodexArgs(
      stage,
      promptPath,
      ["--model", "gpt-5"],
      "/ws/.otto-tmp/s.json",
      "workspace-write"
    );

    expect(args.slice(0, 4)).toEqual([
      "codex",
      "--ask-for-approval",
      "never",
      "exec",
    ]);
    expect(args).toContain("--json");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("bypassPermissions");
    expect(args.at(-1)).toContain(promptPath);
  });

  it("adds .git to Codex writable roots under workspace-write so commits work", () => {
    const args = buildCodexArgs(
      stage,
      promptPath,
      [],
      undefined,
      "workspace-write"
    );
    const ci = args.indexOf("-c");
    expect(ci).toBeGreaterThan(-1);
    expect(args[ci + 1]).toBe(
      'sandbox_workspace_write.writable_roots=[".git"]'
    );
  });

  it("omits the writable-roots override under danger-full-access", () => {
    const args = buildCodexArgs(
      stage,
      promptPath,
      [],
      undefined,
      "danger-full-access"
    );
    expect(args).not.toContain("-c");
    expect(args.join(" ")).not.toContain("writable_roots");
  });

  it("buildEnv preserves CODEX_API_KEY and maps OPENAI_API_KEY only when needed", () => {
    expect(
      buildCodexEnv({ CODEX_API_KEY: "codex", OPENAI_API_KEY: "openai" })
    ).toMatchObject({
      CODEX_API_KEY: "codex",
      OPENAI_API_KEY: "openai",
    });
    expect(buildCodexEnv({ OPENAI_API_KEY: "openai" })).toMatchObject({
      CODEX_API_KEY: "openai",
      OPENAI_API_KEY: "openai",
    });
  });

  it("parses Codex JSONL events into a StageResult", () => {
    const parse = createCodexStreamParser();
    expect(
      parse({ type: "thread.started", thread_id: "th_123" })
    ).toBeUndefined();
    expect(
      parse({
        type: "item.completed",
        item: {
          id: "i_2",
          type: "agent_message",
          text: "Done: README summarized.",
        },
      })
    ).toBeUndefined();

    expect(
      parse({
        type: "turn.completed",
        usage: {
          input_tokens: 1200,
          cached_input_tokens: 300,
          output_tokens: 80,
        },
      })
    ).toEqual({
      result: "Done: README summarized.",
      costUsd: 0,
      isError: false,
      apiErrorStatus: null,
      usage: {
        inputTokens: 1200,
        outputTokens: 80,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 300,
      },
      runtimeId: "codex",
    });
  });

  it("parses Codex failed turns as errored StageResults", () => {
    const parse = createCodexStreamParser();
    expect(
      parse({
        type: "turn.failed",
        error: { message: "429 rate limit exceeded" },
      })
    ).toMatchObject({
      result: "429 rate limit exceeded",
      isError: true,
      apiErrorStatus: "429 rate limit exceeded",
      runtimeId: "codex",
    });
  });

  it("extracts Codex reset hints when the CLI supplies them", () => {
    expect(
      resetsAtFromCodexEvent(
        {
          type: "turn.failed",
          error: { message: "rate limit", resets_in_seconds: 120 },
        },
        1000
      )
    ).toBe(1120);
    expect(
      resetsAtFromCodexEvent({
        type: "error",
        error: { message: "rate limit", resets_at: 1_781_517_000 },
      })
    ).toBe(1_781_517_000);
    expect(resetsAtFromCodexEvent({ type: "turn.completed" })).toBeNull();
  });

  it("exposes the parser and env builder on codexRuntime", () => {
    expect(codexRuntime.createStreamParser).toBe(createCodexStreamParser);
    expect(codexRuntime.buildEnv).toBe(buildCodexEnv);
    const r = codexRuntime.parseResultEvent({ result: "legacy" });
    expect(r.runtimeId).toBe("codex");
  });
});

// ── P32: enforced read-only stage access + credential scrubbing ──────────────

describe("stageAccess", () => {
  it("defaults an access-less stage to workspace-write (today's behavior)", () => {
    expect(stageAccess({ name: "s", template: "s.md" })).toBe(
      "workspace-write"
    );
  });
  it("returns the declared access when set", () => {
    expect(
      stageAccess({ name: "s", template: "s.md", access: "read-only" })
    ).toBe("read-only");
    expect(
      stageAccess({ name: "s", template: "s.md", access: "workspace-write" })
    ).toBe("workspace-write");
  });
});

describe("buildClaudeArgs read-only access (P32)", () => {
  const promptPath = ".otto-tmp/prompt.md";

  it("keeps existing workspace-write stages byte-for-byte unchanged", () => {
    const stage = {
      name: "implementer",
      template: "afk.md",
      permissionMode: "bypassPermissions",
    };
    // Absent access resolves to workspace-write ⇒ identical argv to before P32.
    expect(buildClaudeArgs(stage, promptPath, [], "/ws/s.json")).toEqual([
      "claude",
      "--verbose",
      "--print",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--settings",
      "/ws/s.json",
      `Read the full instructions from the file ./${promptPath} in the current workspace and execute them.`,
    ]);
  });

  it("forces safe read-only flags and never bypassPermissions", () => {
    const stage = {
      name: "pr-review",
      template: "pr-review-lens.md",
      // permissionMode is intentionally overridden by read-only.
      permissionMode: "bypassPermissions",
      access: "read-only" as const,
    };
    const args = buildClaudeArgs(stage, promptPath, []);
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");
    // Empty MCP server list — must be an explicit `mcpServers` record; the CLI
    // rejects a bare `{}` ("mcpServers: expected record, received undefined").
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args.join(" ")).not.toContain("bypassPermissions");
    expect(args.at(-1)).toContain(promptPath);
  });

  it("still injects --settings for the read-only sandbox when provided", () => {
    const stage = {
      name: "pr-review",
      template: "pr-review-lens.md",
      access: "read-only" as const,
    };
    const args = buildClaudeArgs(stage, promptPath, [], "/ws/ro.json");
    const sIdx = args.indexOf("--settings");
    expect(sIdx).toBeGreaterThan(-1);
    expect(args[sIdx + 1]).toBe("/ws/ro.json");
    const promptIdx = args.findIndex((a) => a.includes(promptPath));
    expect(sIdx).toBeLessThan(promptIdx);
  });
});

describe("buildCodexArgs read-only access (P32)", () => {
  const promptPath = ".otto-tmp/prompt.md";

  it("resolves to read-only sandbox + ephemeral with no writable_roots", () => {
    const args = buildCodexArgs(
      { name: "pr-review", template: "pr-review-lens.md", access: "read-only" },
      promptPath,
      [],
      undefined,
      "read-only"
    );
    expect(args).toContain("--ephemeral");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args.join(" ")).not.toContain("writable_roots");
    expect(args).not.toContain("-c");
  });

  it("forces read-only even when the runner mode would be workspace-write", () => {
    // A read-only stage must never be weakened by OTTO_RUNNER=host: the access
    // wins over the passed sandbox mode.
    const args = buildCodexArgs(
      { name: "pr-review", template: "pr-review-lens.md", access: "read-only" },
      promptPath,
      [],
      undefined,
      "danger-full-access"
    );
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("--ephemeral");
    expect(args.join(" ")).not.toContain("writable_roots");
  });

  it("leaves workspace-write stages unchanged (no --ephemeral)", () => {
    const args = buildCodexArgs(
      { name: "implementer", template: "afk.md" },
      promptPath,
      [],
      undefined,
      "workspace-write"
    );
    expect(args).not.toContain("--ephemeral");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args.join(" ")).toContain("writable_roots");
  });
});

describe("buildSandboxSettings read-only access (P32)", () => {
  it("returns a no-write, no-network, no-escape-hatch sandbox for read-only", () => {
    expect(buildSandboxSettings("/ws", [], [], "read-only")).toEqual({
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: [] },
        network: { allowedDomains: [] },
        excludedCommands: [],
      },
    });
  });

  it("ignores extra write roots and network domains under read-only", () => {
    expect(
      buildSandboxSettings("/ws", ["github.com"], ["/other"], "read-only")
    ).toEqual({
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: [] },
        network: { allowedDomains: [] },
        excludedCommands: [],
      },
    });
  });

  it("defaults to today's workspace-write settings when access is omitted", () => {
    expect(buildSandboxSettings("/ws", [])).toEqual({
      sandbox: {
        enabled: true,
        filesystem: { allowWrite: ["/ws"] },
        excludedCommands: ["gh *", "gcloud *", "terraform *"],
      },
    });
  });
});

describe("buildReviewChildEnv (P32 credential scrubbing)", () => {
  it("removes GitHub/SSH/askpass vars, redirects gh/git config, preserves model keys", () => {
    const env = buildReviewChildEnv(
      {
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        SSH_AUTH_SOCK: "/tmp/agent",
        GIT_ASKPASS: "/usr/bin/askpass",
        ANTHROPIC_API_KEY: "model-key",
        OPENAI_API_KEY: "openai-key",
        CODEX_API_KEY: "codex-key",
      },
      "/ws/.otto-tmp/pr-review/empty-gh-config"
    );
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("model-key");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    expect(env.CODEX_API_KEY).toBe("codex-key");
    expect(env.GH_CONFIG_DIR).toBe("/ws/.otto-tmp/pr-review/empty-gh-config");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe(devNull);
  });

  it("clears inherited git-config env injection, then installs one empty credential.helper", () => {
    const env = buildReviewChildEnv(
      {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "store",
        GIT_CONFIG_KEY_1: "url.https://x.insteadof",
        GIT_CONFIG_VALUE_1: "ssh://x",
        GIT_CONFIG_PARAMETERS: "'credential.helper=store'",
      },
      "/ws/empty"
    );
    // Exactly one config pair remains: the empty credential.helper neutralizer.
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined();
    // GIT_CONFIG_PARAMETERS is git's inline `-c`-equivalent injection vector —
    // it must be scrubbed too, not just the count/key/value trio.
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  });

  it("does not mutate the caller's env object", () => {
    const original = { GH_TOKEN: "secret", ANTHROPIC_API_KEY: "k" };
    buildReviewChildEnv(original, "/ws/empty");
    expect(original.GH_TOKEN).toBe("secret");
  });
});

describe("resolveChildEnv (P32 child-env threading)", () => {
  const runtimeNoEnv = { ...claudeRuntime };
  const runtimeWithEnv = {
    ...codexRuntime,
    buildEnv: (e?: NodeJS.ProcessEnv) => ({ ...e, MAPPED: "1" }),
  };

  it("passes the supplied childEnv (not global process.env) into buildEnv", () => {
    const supplied = { ONLY_HERE: "yes" } as NodeJS.ProcessEnv;
    const out = resolveChildEnv(runtimeWithEnv, supplied);
    expect(out.ONLY_HERE).toBe("yes");
    expect(out.MAPPED).toBe("1");
  });

  it("returns the base env unchanged when the runtime has no buildEnv", () => {
    const supplied = { ONLY_HERE: "yes" } as NodeJS.ProcessEnv;
    expect(resolveChildEnv(runtimeNoEnv, supplied)).toBe(supplied);
  });

  it("falls back to the provided fallback env when childEnv is absent", () => {
    const fallback = { FROM_FALLBACK: "1" } as NodeJS.ProcessEnv;
    expect(resolveChildEnv(runtimeNoEnv, undefined, fallback)).toBe(fallback);
  });
});
