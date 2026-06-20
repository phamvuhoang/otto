import { describe, expect, it } from "vitest";

import {
  parseFlags,
  parseIssueRef,
  parseDurationMs,
  printConfig,
} from "../cli-help.js";

/** Capture printConfig's stdout for a given options bag. */
function configOutput(opts: Parameters<typeof printConfig>[3]): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  try {
    printConfig("otto-ghafk", "/ws", "/pkg", opts);
  } finally {
    (process.stdout as { write: unknown }).write = orig;
  }
  return chunks.join("");
}

describe("parseIssueRef", () => {
  it("accepts a bare number", () => {
    expect(parseIssueRef("42")).toBe(42);
  });
  it("accepts the #N hash form", () => {
    expect(parseIssueRef("#42")).toBe(42);
  });
  it("accepts the owner/repo#N form", () => {
    expect(parseIssueRef("phamvuhoang/otto#42")).toBe(42);
  });
  it("accepts a GitHub issue URL", () => {
    expect(parseIssueRef("https://github.com/phamvuhoang/otto/issues/42")).toBe(
      42
    );
  });
  it("accepts an issue URL with a comment anchor", () => {
    expect(
      parseIssueRef(
        "https://github.com/phamvuhoang/otto/issues/42#issuecomment-99"
      )
    ).toBe(42);
  });
  it("trims surrounding whitespace", () => {
    expect(parseIssueRef("  42  ")).toBe(42);
  });
  it.each(["foo", "0", "007", "-3", "42x", "", "#", "owner/repo#", "abc#1x"])(
    "rejects %j",
    (bad) => {
      expect(() => parseIssueRef(bad)).toThrow();
    }
  );
  it("rejects an unsafe, absurdly large number", () => {
    expect(() => parseIssueRef("99999999999999999999")).toThrow();
  });
});

describe("parseFlags --issue", () => {
  it("parses --issue into a number", () => {
    expect(parseFlags(["--issue", "42", "5"]).issue).toBe(42);
  });
  it("leaves issue undefined when absent", () => {
    expect(parseFlags(["5"]).issue).toBeUndefined();
  });
  it("keeps iterations as the trailing positional", () => {
    expect(parseFlags(["--issue", "42", "5"]).rest).toEqual(["5"]);
  });
  it("throws when --issue has no value", () => {
    expect(() => parseFlags(["--issue"])).toThrow("--issue requires a value");
  });
  it("throws when --issue value is invalid", () => {
    expect(() => parseFlags(["--issue", "foo", "5"])).toThrow();
  });
  it("uses an injected parseIssue parser when provided (Linear mode)", () => {
    const f = parseFlags(["--issue", "eng-12", "5"], {
      parseIssue: (raw) => raw.toUpperCase(),
    });
    expect(f.issue).toBe("ENG-12");
  });
  it("still defaults to the GitHub number parser without opts", () => {
    expect(parseFlags(["--issue", "42", "5"]).issue).toBe(42);
  });
});

describe("parseFlags --include-sub-issues", () => {
  it("defaults to false", () => {
    expect(parseFlags(["3"]).includeSubIssues).toBe(false);
  });
  it("is set by the boolean flag and consumes no value", () => {
    const f = parseFlags(["--include-sub-issues", "3"]);
    expect(f.includeSubIssues).toBe(true);
    expect(f.rest).toEqual(["3"]);
  });
});

describe("parseDurationMs", () => {
  it("parses bare seconds", () => expect(parseDurationMs("90")).toBe(90_000));
  it("parses m/h/s suffixes", () => {
    expect(parseDurationMs("90m")).toBe(90 * 60_000);
    expect(parseDurationMs("6h")).toBe(6 * 3600_000);
    expect(parseDurationMs("45s")).toBe(45_000);
  });
  it("throws on garbage", () => expect(() => parseDurationMs("abc")).toThrow());
});

describe("parseFlags --max-wait / --fresh", () => {
  it("parses --max-wait and --fresh", () => {
    const f = parseFlags(["--max-wait", "2h", "--fresh", "5"]);
    expect(f.maxWaitMs).toBe(2 * 3600_000);
    expect(f.fresh).toBe(true);
    expect(f.rest).toEqual(["5"]);
  });
  it("errors when --max-wait has no value", () => {
    expect(() => parseFlags(["--max-wait"])).toThrow(
      /--max-wait requires a value/
    );
  });
  it("errors on an invalid --max-wait value", () => {
    expect(() => parseFlags(["--max-wait", "nope"])).toThrow();
  });
});

describe("parseFlags --token-mode", () => {
  it.each(["off", "measure", "reduce"] as const)("parses %s", (mode) => {
    const f = parseFlags(["--token-mode", mode, "5"]);
    expect(f.tokenMode).toBe(mode);
    expect(f.rest).toEqual(["5"]);
  });

  it("errors when --token-mode has no value", () => {
    expect(() => parseFlags(["--token-mode"])).toThrow(
      /--token-mode requires a value/
    );
  });

  it("errors on an invalid --token-mode value", () => {
    expect(() => parseFlags(["--token-mode", "aggressive"])).toThrow(
      /--token-mode must be one of/
    );
  });
});

describe("parseFlags --agent", () => {
  it.each(["claude", "codex"] as const)("parses %s", (id) => {
    const f = parseFlags(["--agent", id, "5"]);
    expect(f.agent).toBe(id);
    expect(f.rest).toEqual(["5"]);
  });

  it("errors when --agent has no value", () => {
    expect(() => parseFlags(["--agent"])).toThrow(/--agent requires a value/);
  });

  it("errors on an invalid --agent value", () => {
    expect(() => parseFlags(["--agent", "gpt"])).toThrow(
      /--agent must be one of claude\|codex/
    );
  });

  it("defaults agent to undefined when absent", () => {
    expect(parseFlags(["5"]).agent).toBeUndefined();
  });
});

describe("parseFlags --fallback-agent / --auto-switch-on-limit", () => {
  it.each(["claude", "codex"] as const)("parses --fallback-agent %s", (id) => {
    const f = parseFlags(["--fallback-agent", id, "5"]);
    expect(f.fallbackAgent).toBe(id);
    expect(f.rest).toEqual(["5"]);
  });

  it("errors when --fallback-agent has no value", () => {
    expect(() => parseFlags(["--fallback-agent"])).toThrow(
      /--fallback-agent requires a value/
    );
  });

  it("errors on an invalid --fallback-agent value", () => {
    expect(() => parseFlags(["--fallback-agent", "gpt"])).toThrow(
      /--fallback-agent must be one of claude\|codex/
    );
  });

  it("parses --auto-switch-on-limit as a boolean toggle", () => {
    expect(parseFlags(["--auto-switch-on-limit", "5"]).autoSwitchOnLimit).toBe(
      true
    );
    expect(parseFlags(["5"]).autoSwitchOnLimit).toBe(false);
  });

  it("defaults fallbackAgent to undefined when absent", () => {
    expect(parseFlags(["5"]).fallbackAgent).toBeUndefined();
  });
});

describe("printConfig fallback", () => {
  it("shows off when no fallback is configured", () => {
    const out = configOutput({});
    expect(out).toMatch(/fallback\s+off/);
  });

  it("shows the fallback runtime, source, and auto-switch state", () => {
    const out = configOutput({
      fallbackAgentId: "codex",
      fallbackAgentDisplayName: "Codex CLI",
      fallbackSource: "flag",
      autoSwitchOnLimit: true,
    });
    expect(out).toMatch(/fallback\s+codex \(Codex CLI, flag\) · auto-switch on/);
  });

  it("warns when auto-switch is on but no fallback agent is set", () => {
    const out = configOutput({ autoSwitchOnLimit: true });
    expect(out).toMatch(/fallback\s+auto-switch on · no fallback agent set/);
  });

  it("reports an invalid fallback selection without throwing", () => {
    const out = configOutput({
      fallbackError: 'OTTO_FALLBACK_AGENT must be one of claude|codex, got: "gpt"',
    });
    expect(out).toMatch(/fallback\s+invalid/);
  });
});

describe("printConfig runtime", () => {
  it("shows the active runtime, display name, and selection source", () => {
    const out = configOutput({
      agentId: "codex",
      agentDisplayName: "Codex CLI",
      agentSource: "env",
    });
    expect(out).toMatch(/runtime\s+codex \(Codex CLI\)/);
    expect(out).toMatch(/runtime source\s+env/);
  });

  it("reports an invalid runtime selection without throwing", () => {
    const out = configOutput({ agentError: 'OTTO_AGENT must be one of claude|codex, got: "gpt"' });
    expect(out).toMatch(/runtime\s+invalid/);
  });

  it("shows a runtime-aware model line using the provider-specific override", () => {
    const prev = {
      OTTO_MODEL: process.env.OTTO_MODEL,
      OTTO_CODEX_MODEL: process.env.OTTO_CODEX_MODEL,
    };
    process.env.OTTO_MODEL = "opus";
    process.env.OTTO_CODEX_MODEL = "gpt-5";
    try {
      const out = configOutput({ agentId: "codex", agentDisplayName: "Codex CLI" });
      expect(out).toMatch(/model\s+gpt-5 \(OTTO_CODEX_MODEL\)/);
    } finally {
      if (prev.OTTO_MODEL == null) delete process.env.OTTO_MODEL;
      else process.env.OTTO_MODEL = prev.OTTO_MODEL;
      if (prev.OTTO_CODEX_MODEL == null) delete process.env.OTTO_CODEX_MODEL;
      else process.env.OTTO_CODEX_MODEL = prev.OTTO_CODEX_MODEL;
    }
  });

  it("names the active runtime in the model-default line when no model env is set", () => {
    const prev = {
      OTTO_MODEL: process.env.OTTO_MODEL,
      OTTO_CODEX_MODEL: process.env.OTTO_CODEX_MODEL,
      OTTO_CLAUDE_MODEL: process.env.OTTO_CLAUDE_MODEL,
    };
    delete process.env.OTTO_MODEL;
    delete process.env.OTTO_CODEX_MODEL;
    delete process.env.OTTO_CLAUDE_MODEL;
    try {
      const out = configOutput({ agentId: "codex", agentDisplayName: "Codex CLI" });
      expect(out).toMatch(/model\s+codex CLI default \(OTTO_CODEX_MODEL \/ OTTO_MODEL unset\)/);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("shows codex preflight rows (not claude) when codex is the active runtime", () => {
    // Host-independent: the preflight row LABELS track the selected runtime even
    // though ok/detail depend on the host (issue #24 P3).
    // Match preflight ROWS (prefixed with a ✓/✗ status glyph), not the model
    // line which always mentions "claude CLI default".
    const claudeOut = configOutput({ agentId: "claude" });
    expect(claudeOut).toMatch(/[✓✗] claude CLI/);
    expect(claudeOut).not.toMatch(/[✓✗] codex CLI/);

    const codexOut = configOutput({ agentId: "codex", agentDisplayName: "Codex CLI" });
    expect(codexOut).toMatch(/[✓✗] codex CLI/);
    expect(codexOut).toMatch(/[✓✗] codex auth/);
    expect(codexOut).not.toMatch(/[✓✗] claude CLI/);
  });
});

describe("parseFlags --branch / --branch-prefix", () => {
  it("parses --branch and --branch-prefix", () => {
    const f = parseFlags([
      "--branch",
      "worktree",
      "--branch-prefix",
      "bot/",
      "5",
    ]);
    expect(f.branch).toBe("worktree");
    expect(f.branchPrefix).toBe("bot/");
    expect(f.rest).toEqual(["5"]);
  });
  it("rejects an invalid --branch value", () => {
    expect(() => parseFlags(["--branch", "nope"])).toThrow(/--branch must be/);
  });
  it("errors when --branch has no value", () => {
    expect(() => parseFlags(["--branch"])).toThrow(/--branch requires a value/);
  });
  it("captures the raw --branch-convention value", () => {
    const f = parseFlags(["--branch-convention", "feat", "5"]);
    expect(f.branchConvention).toBe("feat");
    expect(f.rest).toEqual(["5"]);
  });
  it("errors when --branch-convention has no value", () => {
    expect(() => parseFlags(["--branch-convention"])).toThrow(
      /--branch-convention requires a value/
    );
  });
});

describe("parseFlags --repo", () => {
  it("captures the raw --repo value", () => {
    const f = parseFlags(["--watch", "--repo", "owner/name", "5"]);
    expect(f.repo).toBe("owner/name");
    expect(f.rest).toEqual(["5"]);
  });
  it("leaves repo undefined when absent", () => {
    expect(parseFlags(["5"]).repo).toBeUndefined();
  });
  it("errors when --repo has no value", () => {
    expect(() => parseFlags(["--repo"])).toThrow(/--repo requires a value/);
  });
  it("collects repeated --repo into repos, keeping repo as the first (multi-target)", () => {
    const f = parseFlags([
      "--watch",
      "--repo",
      "acme/api",
      "--repo",
      "acme/web",
      "20",
    ]);
    expect(f.repos).toEqual(["acme/api", "acme/web"]);
    expect(f.repo).toBe("acme/api");
    expect(f.rest).toEqual(["20"]);
  });
  it("leaves repos empty when no --repo is given", () => {
    expect(parseFlags(["5"]).repos).toEqual([]);
  });
});

describe("parseFlags --project", () => {
  it("captures the raw --project value", () => {
    const f = parseFlags(["--watch", "--project", "Roadmap Q3", "5"]);
    expect(f.project).toBe("Roadmap Q3");
    expect(f.rest).toEqual(["5"]);
  });
  it("leaves project undefined when absent", () => {
    expect(parseFlags(["5"]).project).toBeUndefined();
  });
  it("errors when --project has no value", () => {
    expect(() => parseFlags(["--project"])).toThrow(
      /--project requires a value/
    );
  });
  it("collects repeated --project into projects, keeping project as the first (multi-target)", () => {
    const f = parseFlags([
      "--watch",
      "--project",
      "Roadmap Q3",
      "--project",
      "Bugs",
      "20",
    ]);
    expect(f.projects).toEqual(["Roadmap Q3", "Bugs"]);
    expect(f.project).toBe("Roadmap Q3");
    expect(f.rest).toEqual(["20"]);
  });
  it("leaves projects empty when no --project is given", () => {
    expect(parseFlags(["5"]).projects).toEqual([]);
  });
});

describe("printConfig scope", () => {
  it("shows the resolved watch scope when provided", () => {
    const out = configOutput({ watchScope: "github acme/web" });
    expect(out).toMatch(/scope\s+github acme\/web/);
  });
  it("shows a default when no scope is resolved", () => {
    const out = configOutput({});
    expect(out).toMatch(/scope\s+default/);
  });
});

describe("printConfig token mode", () => {
  it("shows the resolved token mode", () => {
    const out = configOutput({ tokenMode: "measure" });
    expect(out).toMatch(/token mode\s+measure/);
  });
});

describe("printConfig branch convention", () => {
  it("shows the resolved branch convention when provided", () => {
    const out = configOutput({
      branchStrategy: "branch",
      branchConvention: "feat",
    });
    expect(out).toMatch(/branch\s+branch \(convention "feat"\)/);
  });
  it("falls back to the prefix display when no convention is set", () => {
    const out = configOutput({
      branchStrategy: "branch",
      branchPrefix: "bot/",
    });
    expect(out).toMatch(/branch\s+branch \(prefix "bot\/"\)/);
  });
});

describe("parseFlags --verify / --apply-review", () => {
  it("parses --verify (boolean)", () => {
    const f = parseFlags(["--verify", "plan.md prd.md"]);
    expect(f.verify).toBe(true);
    expect(f.rest).toEqual(["plan.md prd.md"]);
  });
  it("parses --apply-review <doc>", () => {
    const f = parseFlags(["--apply-review", "review.md", "10"]);
    expect(f.applyReview).toBe("review.md");
    expect(f.rest).toEqual(["10"]);
  });
  it("errors when --apply-review has no value", () => {
    expect(() => parseFlags(["--apply-review"])).toThrow(
      /--apply-review requires a value/
    );
  });
  it("defaults verify false and applyReview undefined", () => {
    const f = parseFlags(["5"]);
    expect(f.verify).toBe(false);
    expect(f.applyReview).toBeUndefined();
  });
});

describe("parseFlags --explain-routing", () => {
  it("defaults explainRouting to false", () => {
    expect(parseFlags(["5"]).explainRouting).toBe(false);
  });
  it("sets explainRouting when the flag is present", () => {
    expect(parseFlags(["--explain-routing", "5"]).explainRouting).toBe(true);
  });
});

describe("parseFlags --context-report", () => {
  it("defaults contextReport to false", () => {
    expect(parseFlags(["5"]).contextReport).toBe(false);
  });
  it("sets contextReport when the flag is present", () => {
    expect(parseFlags(["--context-report"]).contextReport).toBe(true);
  });
});

describe("printConfig routing", () => {
  it("shows the router off by default", () => {
    expect(configOutput({})).toMatch(/routing\s+off/);
  });
  it("shows adaptive routing with explain on", () => {
    const out = configOutput({ adaptiveRouter: true, explainRouting: true });
    expect(out).toMatch(/routing\s+adaptive · explain on/);
  });
  it("flags --explain-routing as ineffective without the router", () => {
    const out = configOutput({ adaptiveRouter: false, explainRouting: true });
    expect(out).toMatch(/routing\s+off \(--explain-routing needs --adaptive-router\)/);
  });
});
