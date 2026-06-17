import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  deriveTaskKey,
  describeScope,
  parseGithubRepo,
  type WorkScope,
  type WorkSource,
} from "../task-key.js";

/** True if `name` is accepted by git as a branch ref. */
function isGitBranchSafe(name: string): boolean {
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("deriveTaskKey", () => {
  it("plan source → plan-<slug>", () => {
    expect(deriveTaskKey({ provider: "plan", slug: "foo" })).toBe("plan-foo");
  });

  it("github with owner/repo → gh-<owner>-<repo>-<issue>", () => {
    expect(
      deriveTaskKey({
        provider: "github",
        owner: "phamvuhoang",
        repo: "otto",
        issue: 14,
      })
    ).toBe("gh-phamvuhoang-otto-14");
  });

  it("github with a slug appends it", () => {
    expect(
      deriveTaskKey({
        provider: "github",
        owner: "phamvuhoang",
        repo: "otto",
        issue: 14,
        slug: "linear-afk",
      })
    ).toBe("gh-phamvuhoang-otto-14-linear-afk");
  });

  it("github without owner/repo → gh-<issue> (default scope)", () => {
    expect(deriveTaskKey({ provider: "github", issue: 21 })).toBe("gh-21");
  });

  it("linear with team + project → linear-<team>-<project>-<issue>", () => {
    expect(
      deriveTaskKey({
        provider: "linear",
        team: "ENG",
        project: "Roadmap Q3",
        issue: "ENG-123",
        slug: "watch-scope",
      })
    ).toBe("linear-eng-roadmap-q3-eng-123-watch-scope");
  });

  it("linear without project omits it", () => {
    expect(
      deriveTaskKey({ provider: "linear", team: "ENG", issue: "ENG-9" })
    ).toBe("linear-eng-eng-9");
  });

  it("sanitizes uppercase, spaces, slashes and punctuation to [a-z0-9-]", () => {
    const key = deriveTaskKey({
      provider: "github",
      owner: "Acme Corp",
      repo: "Web/App.git",
      issue: 7,
      slug: "Fix: the THING!!",
    });
    expect(key).toBe("gh-acme-corp-web-app-git-7-fix-the-thing");
    expect(key).toMatch(/^[a-z0-9-]+$/);
  });

  it("caps the free-text slug at 40 chars", () => {
    const long = "a".repeat(80);
    const key = deriveTaskKey({ provider: "plan", slug: long });
    expect(key).toBe("plan-" + "a".repeat(40));
  });

  it("derived keys are git-branch-safe, bare and under a convention prefix", () => {
    const sources: WorkSource[] = [
      { provider: "plan", slug: "foo bar" },
      { provider: "github", owner: "Acme", repo: "Web/App", issue: 7, slug: "X!" },
      {
        provider: "linear",
        team: "ENG",
        project: "Roadmap Q3",
        issue: "ENG-123",
      },
    ];
    for (const s of sources) {
      const key = deriveTaskKey(s);
      expect(isGitBranchSafe(key)).toBe(true);
      expect(isGitBranchSafe("otto/" + key)).toBe(true);
      expect(isGitBranchSafe("feat/" + key)).toBe(true);
    }
  });

  it("keys contain no path separators or traversal (filesystem-safe)", () => {
    const key = deriveTaskKey({
      provider: "github",
      owner: "../../etc",
      repo: "..",
      issue: 1,
    });
    expect(key).not.toContain("/");
    expect(key.split("-")).not.toContain("..");
  });
});

describe("describeScope", () => {
  it("plan", () => {
    expect(describeScope({ provider: "plan" })).toBe("plan (local workspace)");
  });

  it("github with repo", () => {
    expect(
      describeScope({ provider: "github", owner: "owner", repo: "name" })
    ).toBe("github owner/name");
  });

  it("github without repo → default", () => {
    expect(describeScope({ provider: "github" })).toBe("github (default repo)");
  });

  it("linear with team + project", () => {
    expect(
      describeScope({ provider: "linear", team: "ENG", project: "Roadmap Q3" })
    ).toBe("linear team:ENG project:Roadmap Q3");
  });

  it("linear with team only", () => {
    expect(describeScope({ provider: "linear", team: "ENG" })).toBe(
      "linear team:ENG"
    );
  });

  it("linear with neither team nor project → default", () => {
    expect(describeScope({ provider: "linear" })).toBe(
      "linear (default team)"
    );
  });
});

describe("parseGithubRepo", () => {
  it("parses an owner/repo pair", () => {
    expect(parseGithubRepo("phamvuhoang/otto")).toEqual({
      owner: "phamvuhoang",
      repo: "otto",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGithubRepo("  acme/web  ")).toEqual({
      owner: "acme",
      repo: "web",
    });
  });

  it("allows hyphens, dots and underscores in the repo name", () => {
    expect(parseGithubRepo("my-org/web.app_v2")).toEqual({
      owner: "my-org",
      repo: "web.app_v2",
    });
  });

  it("preserves the original case (gh display form)", () => {
    expect(parseGithubRepo("PhamVuHoang/Otto")).toEqual({
      owner: "PhamVuHoang",
      repo: "Otto",
    });
  });

  it.each([
    "",
    "owner",
    "owner/",
    "/repo",
    "owner/repo/extra",
    "own er/repo",
    "owner/re po",
    "owner/$(rm -rf ~)",
    "owner/repo;ls",
    "-owner/repo",
    "owner-/repo",
    "owner/..",
    "owner/.",
  ])("rejects unsafe or malformed %j", (bad) => {
    expect(() => parseGithubRepo(bad)).toThrow();
  });

  it("yields a shell-safe owner/repo string (no metacharacters)", () => {
    const { owner, repo } = parseGithubRepo("a-b/c.d_e");
    expect(`${owner}/${repo}`).toMatch(
      /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
    );
  });
});

// Type-only: WorkScope is structurally the item-less prefix of WorkSource.
const _scope: WorkScope = { provider: "github", owner: "o", repo: "r" };
void _scope;
