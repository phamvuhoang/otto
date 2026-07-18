import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatReviewConfig,
  formatReviewHelp,
  parsePullRequestRef,
  parseReviewFlags,
  readPullRequestReviewConfig,
  resolvePullRequestReviewConfig,
  type PullRequestReviewConfig,
  type ReviewCliFlags,
} from "../review-cli.js";

describe("parsePullRequestRef", () => {
  it("accepts a bare positive integer", () => {
    expect(parsePullRequestRef("123")).toBe(123);
  });

  it("accepts a matching GitHub PR URL", () => {
    expect(
      parsePullRequestRef("https://github.com/acme/web/pull/123", "acme/web")
    ).toBe(123);
  });

  it("is case-insensitive when matching the URL owner/repo against scope", () => {
    expect(
      parsePullRequestRef("https://github.com/ACME/WEB/pull/123", "acme/web")
    ).toBe(123);
  });

  it("throws when the URL repository does not match the given scope", () => {
    expect(() =>
      parsePullRequestRef("https://github.com/other/repo/pull/5", "acme/web")
    ).toThrow();
  });

  it("accepts a URL with no repository scope given", () => {
    expect(parsePullRequestRef("https://github.com/acme/web/pull/9")).toBe(9);
  });

  it.each(["0", "-3", "007", "abc", "", "  "])("rejects %j", (bad) => {
    expect(() => parsePullRequestRef(bad)).toThrow();
  });

  it("rejects an unsafe, absurdly large number", () => {
    expect(() => parsePullRequestRef("99999999999999999999")).toThrow();
  });
});

describe("parseReviewFlags", () => {
  it("parses --repo and --pr", () => {
    const flags = parseReviewFlags(["--repo", "acme/web", "--pr", "123"]);
    expect(flags.repo).toBe("acme/web");
    expect(flags.pr).toBe(123);
  });

  it("parses --pr as a matching GitHub PR URL", () => {
    const flags = parseReviewFlags([
      "--repo",
      "acme/web",
      "--pr",
      "https://github.com/acme/web/pull/123",
    ]);
    expect(flags.pr).toBe(123);
  });

  it("throws on a --pr URL that does not match --repo, regardless of flag order", () => {
    expect(() =>
      parseReviewFlags([
        "--pr",
        "https://github.com/other/repo/pull/5",
        "--repo",
        "acme/web",
      ])
    ).toThrow();
  });

  it("throws on a non-positive --pr", () => {
    expect(() => parseReviewFlags(["--pr", "0"])).toThrow();
  });

  it("throws when --repo has no value", () => {
    expect(() => parseReviewFlags(["--repo"])).toThrow(
      "--repo requires a value"
    );
  });

  it("throws when --pr has no value", () => {
    expect(() => parseReviewFlags(["--pr"])).toThrow("--pr requires a value");
  });

  it("throws on an invalid --repo format", () => {
    expect(() => parseReviewFlags(["--repo", "not-a-repo"])).toThrow();
  });

  it("throws on an unknown flag", () => {
    expect(() => parseReviewFlags(["--bogus"])).toThrow(/unknown flag/);
  });

  it("throws on an unexpected bare argument", () => {
    expect(() => parseReviewFlags(["stray"])).toThrow();
  });

  it("rejects AFK-only flags", () => {
    for (const flag of [
      "--fresh",
      "--verify",
      "--plan",
      "--fan-out",
      "--adaptive-router",
      "--use-skills",
      "--sharpen-input",
      "--branch",
      "--review-panel",
      "--include-sub-issues",
    ]) {
      expect(() => parseReviewFlags([flag]), flag).toThrow();
    }
  });

  it("parses shared runtime flags through the existing helpers", () => {
    const flags = parseReviewFlags([
      "--agent",
      "codex",
      "--fallback-agent",
      "codex",
      "--token-mode",
      "measure",
      "--context-compressor",
      "headroom",
      "--auto-switch-on-limit",
      "--model-routing",
    ]);
    expect(flags.agent).toBe("codex");
    expect(flags.fallbackAgent).toBe("codex");
    expect(flags.tokenMode).toBe("measure");
    expect(flags.contextCompressor).toBe("headroom");
    expect(flags.autoSwitchOnLimit).toBe(true);
    expect(flags.modelRouting).toBe(true);
  });

  it("rejects an invalid --agent value", () => {
    expect(() => parseReviewFlags(["--agent", "bogus"])).toThrow();
  });

  it("rejects an invalid --token-mode value", () => {
    expect(() => parseReviewFlags(["--token-mode", "bogus"])).toThrow();
  });

  it("rejects an invalid --context-compressor value", () => {
    expect(() => parseReviewFlags(["--context-compressor", "bogus"])).toThrow();
  });

  it("parses positive --watch-interval", () => {
    expect(
      parseReviewFlags(["--watch", "--watch-interval", "60"]).watchIntervalSec
    ).toBe(60);
  });

  it("rejects a non-positive --watch-interval", () => {
    expect(() => parseReviewFlags(["--watch-interval", "0"])).toThrow();
  });

  it("rejects a non-positive --max-retries", () => {
    expect(() => parseReviewFlags(["--max-retries", "0"])).toThrow();
  });

  it("rejects a non-positive --budget", () => {
    expect(() => parseReviewFlags(["--budget", "0"])).toThrow();
  });

  it("accepts --cooldown 0 (non-negative, not required positive)", () => {
    expect(parseReviewFlags(["--cooldown", "0"]).cooldownMs).toBe(0);
  });

  it("validates the --output enum at parse time", () => {
    expect(() => parseReviewFlags(["--output", "bogus"])).toThrow();
    expect(parseReviewFlags(["--output", "markdown"]).output).toBe("markdown");
  });

  it("parses --spec-issue / --spec-file / --prompt as raw strings", () => {
    expect(parseReviewFlags(["--spec-issue", "42"]).specIssue).toBe("42");
    expect(parseReviewFlags(["--spec-file", "spec.md"]).specFile).toBe(
      "spec.md"
    );
    expect(parseReviewFlags(["--prompt", "do the thing"]).prompt).toBe(
      "do the thing"
    );
  });

  it("does not reject at parse time when multiple review-input flags are given (deferred to the resolver)", () => {
    expect(() =>
      parseReviewFlags(["--spec-issue", "1", "--spec-file", "a.md"])
    ).not.toThrow();
  });

  it("does not reject a whitespace-only --prompt at parse time (deferred to the resolver)", () => {
    expect(() => parseReviewFlags(["--prompt", "   "])).not.toThrow();
  });

  it("parses boolean flags", () => {
    const flags = parseReviewFlags([
      "--watch",
      "--github-review",
      "--detach",
      "--notify",
      "--verbose",
      "--help",
      "--version",
      "--print-config",
    ]);
    expect(flags.watch).toBe(true);
    expect(flags.githubReview).toBe(true);
    expect(flags.detach).toBe(true);
    expect(flags.notify).toBe(true);
    expect(flags.verbose).toBe(true);
    expect(flags.help).toBe(true);
    expect(flags.version).toBe(true);
    expect(flags.printConfig).toBe(true);
  });
});

function baseFlags(overrides: Partial<ReviewCliFlags> = {}): ReviewCliFlags {
  return {
    help: false,
    version: false,
    printConfig: false,
    watch: false,
    githubReview: false,
    autoSwitchOnLimit: false,
    modelRouting: false,
    detach: false,
    notify: false,
    verbose: false,
    ...overrides,
  };
}

describe("resolvePullRequestReviewConfig", () => {
  it("matches the representative watch-mode default assertion", () => {
    expect(
      resolvePullRequestReviewConfig({
        flags: parseReviewFlags(["--repo", "acme/web", "--watch"]),
        env: {},
        config: {},
      })
    ).toMatchObject({
      repository: "acme/web",
      watch: true,
      watchIntervalSec: 300,
      label: "otto-review",
      reviewInput: { kind: "none" },
      output: "comment",
      githubReview: false,
    });
  });

  it("requires --repo", () => {
    expect(() =>
      resolvePullRequestReviewConfig({
        flags: baseFlags({ pr: 1 }),
        env: {},
        config: {},
      })
    ).toThrow("--repo owner/name is required");
  });

  it("requires exactly one of --pr or --watch (neither given)", () => {
    expect(() =>
      resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web" }),
        env: {},
        config: {},
      })
    ).toThrow("exactly one of --pr or --watch is required");
  });

  it("requires exactly one of --pr or --watch (both given)", () => {
    expect(() =>
      resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1, watch: true }),
        env: {},
        config: {},
      })
    ).toThrow("exactly one of --pr or --watch is required");
  });

  it("lower-cases the repository for the stable identity", () => {
    const config = resolvePullRequestReviewConfig({
      flags: baseFlags({ repo: "AcMe/WeB", pr: 1 }),
      env: {},
      config: {},
    });
    expect(config.repository).toBe("acme/web");
  });

  it("one-shot (--pr) default output is text", () => {
    const config = resolvePullRequestReviewConfig({
      flags: baseFlags({ repo: "acme/web", pr: 1 }),
      env: {},
      config: {},
    });
    expect(config.output).toBe("text");
  });

  it("watch default output is comment", () => {
    const config = resolvePullRequestReviewConfig({
      flags: baseFlags({ repo: "acme/web", watch: true }),
      env: {},
      config: {},
    });
    expect(config.output).toBe("comment");
  });

  it("--output-file requires --output markdown", () => {
    expect(() =>
      resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1, outputFile: "out.md" }),
        env: {},
        config: {},
      })
    ).toThrow("--output-file requires --output markdown");
  });

  it("--output-file is accepted with --output markdown", () => {
    const config = resolvePullRequestReviewConfig({
      flags: baseFlags({
        repo: "acme/web",
        pr: 1,
        output: "markdown",
        outputFile: "out.md",
      }),
      env: {},
      config: {},
    });
    expect(config.outputFile).toBe("out.md");
  });

  it("--watch-interval is only valid with --watch", () => {
    expect(() =>
      resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1, watchIntervalSec: 60 }),
        env: {},
        config: {},
      })
    ).toThrow("--watch-interval is only valid with --watch");
  });

  it("--detach is only valid with --watch", () => {
    expect(() =>
      resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1, detach: true }),
        env: {},
        config: {},
      })
    ).toThrow("--detach is only valid with --watch");
  });

  it("--log is only valid with --detach", () => {
    expect(() =>
      resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", watch: true, log: "out.log" }),
        env: {},
        config: {},
      })
    ).toThrow("--log is only valid with --detach");
  });

  it("--log with --detach is fine", () => {
    expect(() =>
      resolvePullRequestReviewConfig({
        flags: baseFlags({
          repo: "acme/web",
          watch: true,
          detach: true,
          log: "out.log",
        }),
        env: {},
        config: {},
      })
    ).not.toThrow();
  });

  describe("flag > env > config > default precedence", () => {
    it("label: flag wins over env and config", () => {
      const config = resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1, label: "from-flag" }),
        env: { OTTO_REVIEW_LABEL: "from-env" },
        config: { label: "from-config" },
      });
      expect(config.label).toBe("from-flag");
    });

    it("label: env wins over config", () => {
      const config = resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1 }),
        env: { OTTO_REVIEW_LABEL: "from-env" },
        config: { label: "from-config" },
      });
      expect(config.label).toBe("from-env");
    });

    it("label: config wins over default", () => {
      const config = resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1 }),
        env: {},
        config: { label: "from-config" },
      });
      expect(config.label).toBe("from-config");
    });

    it("label: default is otto-review", () => {
      const config = resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1 }),
        env: {},
        config: {},
      });
      expect(config.label).toBe("otto-review");
    });

    it("reviewSkill: flag > OTTO_REVIEW_SKILL > pullRequestReview.skill", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({
            repo: "acme/web",
            pr: 1,
            reviewSkill: "flag-skill",
          }),
          env: { OTTO_REVIEW_SKILL: "env-skill" },
          config: { skill: "config-skill" },
        }).reviewSkill
      ).toBe("flag-skill");

      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: { OTTO_REVIEW_SKILL: "env-skill" },
          config: { skill: "config-skill" },
        }).reviewSkill
      ).toBe("env-skill");

      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: {},
          config: { skill: "config-skill" },
        }).reviewSkill
      ).toBe("config-skill");

      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: {},
          config: {},
        }).reviewSkill
      ).toBeUndefined();
    });

    it("output: flag > OTTO_REVIEW_OUTPUT > pullRequestReview.output > default", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1, output: "comment" }),
          env: { OTTO_REVIEW_OUTPUT: "markdown" },
          config: { output: "text" },
        }).output
      ).toBe("comment");

      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: { OTTO_REVIEW_OUTPUT: "markdown" },
          config: { output: "text" },
        }).output
      ).toBe("markdown");

      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: {},
          config: { output: "text" },
        }).output
      ).toBe("text");
    });

    it("output: rejects an invalid env value", () => {
      expect(() =>
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: { OTTO_REVIEW_OUTPUT: "bogus" },
          config: {},
        })
      ).toThrow();
    });

    it("output: rejects an invalid config value", () => {
      expect(() =>
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: {},
          config: { output: "bogus" },
        })
      ).toThrow();
    });
  });

  describe("githubReview", () => {
    it("defaults to false", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: {},
          config: {},
        }).githubReview
      ).toBe(false);
    });

    it("a true config value enables it", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: {},
          config: { githubReview: true },
        }).githubReview
      ).toBe(true);
    });

    it("a false config value leaves it disabled", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: {},
          config: { githubReview: false },
        }).githubReview
      ).toBe(false);
    });

    it("the positive flag overrides a false config value", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1, githubReview: true }),
          env: {},
          config: { githubReview: false },
        }).githubReview
      ).toBe(true);
    });

    it("does not implicitly change output from text to comment", () => {
      const config = resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1, githubReview: true }),
        env: {},
        config: {},
      });
      expect(config.output).toBe("text");
    });
  });

  describe("review input", () => {
    it("zero of the three flags resolves to none", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1 }),
          env: {},
          config: {},
        }).reviewInput
      ).toEqual({ kind: "none" });
    });

    it("--spec-issue resolves to a github-issue request", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1, specIssue: "42" }),
          env: {},
          config: {},
        }).reviewInput
      ).toEqual({ kind: "github-issue", ref: "42" });
    });

    it("--spec-file resolves to a local-file request", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1, specFile: "spec.md" }),
          env: {},
          config: {},
        }).reviewInput
      ).toEqual({ kind: "local-file", path: "spec.md" });
    });

    it("--prompt resolves to a prompt request", () => {
      expect(
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1, prompt: "do the thing" }),
          env: {},
          config: {},
        }).reviewInput
      ).toEqual({ kind: "prompt", text: "do the thing" });
    });

    it("rejects more than one of the three flags", () => {
      expect(() =>
        resolvePullRequestReviewConfig({
          flags: baseFlags({
            repo: "acme/web",
            pr: 1,
            specIssue: "42",
            specFile: "spec.md",
          }),
          env: {},
          config: {},
        })
      ).toThrow(
        "at most one of --spec-issue, --spec-file, or --prompt may be used"
      );
    });

    it("rejects all three given together", () => {
      expect(() =>
        resolvePullRequestReviewConfig({
          flags: baseFlags({
            repo: "acme/web",
            pr: 1,
            specIssue: "42",
            specFile: "spec.md",
            prompt: "x",
          }),
          env: {},
          config: {},
        })
      ).toThrow(
        "at most one of --spec-issue, --spec-file, or --prompt may be used"
      );
    });

    it("rejects a whitespace-only prompt", () => {
      expect(() =>
        resolvePullRequestReviewConfig({
          flags: baseFlags({ repo: "acme/web", pr: 1, prompt: "   " }),
          env: {},
          config: {},
        })
      ).toThrow("--prompt must not be empty");
    });

    it("is invocation-only: a similarly-named env/config value is ignored", () => {
      const config = resolvePullRequestReviewConfig({
        flags: baseFlags({ repo: "acme/web", pr: 1 }),
        env: { OTTO_REVIEW_PROMPT: "ignored", OTTO_REVIEW_SPEC_ISSUE: "99" },
        config: {
          input: { kind: "prompt", text: "ignored" },
          prompt: "ignored",
        },
      });
      expect(config.reviewInput).toEqual({ kind: "none" });
    });
  });
});

describe("readPullRequestReviewConfig", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "otto-review-cli-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns undefined when .otto/config.json is missing", () => {
    expect(readPullRequestReviewConfig(ws)).toBeUndefined();
  });

  it("returns undefined and does not throw on malformed JSON", () => {
    mkdirSync(join(ws, ".otto"), { recursive: true });
    writeFileSync(join(ws, ".otto", "config.json"), "{ not valid json", "utf8");
    expect(() => readPullRequestReviewConfig(ws)).not.toThrow();
    expect(readPullRequestReviewConfig(ws)).toBeUndefined();
  });

  it("returns the raw pullRequestReview value unvalidated when it is a non-object type (validation is the resolver's job)", () => {
    mkdirSync(join(ws, ".otto"), { recursive: true });
    writeFileSync(
      join(ws, ".otto", "config.json"),
      JSON.stringify({ pullRequestReview: "not-an-object" }),
      "utf8"
    );
    expect(readPullRequestReviewConfig(ws)).toBe("not-an-object");
  });

  it("returns the parsed pullRequestReview object on the happy path", () => {
    mkdirSync(join(ws, ".otto"), { recursive: true });
    writeFileSync(
      join(ws, ".otto", "config.json"),
      JSON.stringify({
        pullRequestReview: { label: "otto-review", output: "text" },
      }),
      "utf8"
    );
    expect(readPullRequestReviewConfig(ws)).toEqual({
      label: "otto-review",
      output: "text",
    });
  });
});

describe("formatReviewHelp", () => {
  it("returns a non-empty string mentioning the bin name", () => {
    const help = formatReviewHelp("otto-review");
    expect(help).toContain("otto-review");
    expect(help.length).toBeGreaterThan(0);
  });
});

describe("formatReviewConfig", () => {
  function config(
    overrides: Partial<PullRequestReviewConfig> = {}
  ): PullRequestReviewConfig {
    return {
      repository: "acme/web",
      watch: false,
      watchIntervalSec: 300,
      label: "otto-review",
      reviewInput: { kind: "none" },
      output: "text",
      githubReview: false,
      ...overrides,
    };
  }

  it("shows none for no review input", () => {
    expect(formatReviewConfig(config())).toMatch(/none/);
  });

  it("shows the issue source", () => {
    const out = formatReviewConfig(
      config({ reviewInput: { kind: "github-issue", ref: "42" } })
    );
    expect(out).toContain("42");
  });

  it("shows the file source", () => {
    const out = formatReviewConfig(
      config({ reviewInput: { kind: "local-file", path: "spec.md" } })
    );
    expect(out).toContain("spec.md");
  });

  it("never echoes prompt text, only its char count", () => {
    const secretText = "super-secret-prompt-content-should-never-appear";
    const out = formatReviewConfig(
      config({ reviewInput: { kind: "prompt", text: secretText } })
    );
    expect(out).not.toContain(secretText);
    expect(out).toContain(`direct (${secretText.length} chars)`);
  });
});
