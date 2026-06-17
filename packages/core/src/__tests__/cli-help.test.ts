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
    expect(
      parseIssueRef("https://github.com/phamvuhoang/otto/issues/42")
    ).toBe(42);
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
