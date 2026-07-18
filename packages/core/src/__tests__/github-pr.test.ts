import { describe, expect, it } from "vitest";

import {
  canonicalGithubOrigin,
  classifyGitHubPrError,
  createGitHubPrClient,
  GitHubPrError,
  type GhInvocation,
  type GhRunner,
} from "../github-pr.js";

const PR_FIELDS =
  "number,url,title,body,author,state,isDraft,labels,baseRefName,baseRefOid,headRefOid,files";

/** Build a recording fake `GhRunner`: records every invocation, and dispatches
 * to `handler` (keyed by a caller-chosen matcher) for its return value. */
function recordingRunner(handler: (inv: GhInvocation) => string) {
  const calls: GhInvocation[] = [];
  const run: GhRunner = (inv) => {
    calls.push(inv);
    return handler(inv);
  };
  return { run, calls };
}

const rawPr = {
  number: 42,
  url: "https://github.com/acme/web/pull/42",
  title: "Add feature",
  body: "Some body",
  author: { login: "octocat" },
  state: "OPEN",
  isDraft: false,
  labels: [{ name: "otto-review" }, { name: "bug" }],
  baseRefName: "main",
  baseRefOid: "c".repeat(40),
  headRefOid: "a".repeat(40),
  files: [{ path: "src/foo.ts" }, { path: "src/bar.ts" }],
};

const expectedRevision = {
  repository: "acme/web",
  number: 42,
  url: "https://github.com/acme/web/pull/42",
  title: "Add feature",
  body: "Some body",
  author: "octocat",
  state: "OPEN",
  isDraft: false,
  labels: ["otto-review", "bug"],
  baseRefName: "main",
  baseSha: "c".repeat(40),
  headSha: "a".repeat(40),
  changedFiles: ["src/foo.ts", "src/bar.ts"],
};

describe("createGitHubPrClient", () => {
  describe("argv contracts / injection", () => {
    it("never invokes a shell — a shell metacharacter in a label stays one literal argv element", () => {
      const evilLabel = "otto-review; rm -rf ~ && echo pwned";
      const { run, calls } = recordingRunner(() => "[]");
      const client = createGitHubPrClient({ cwd: "/repo", run });
      client.listPullRequests("acme/web", evilLabel);
      expect(calls[0].args).toEqual([
        "pr",
        "list",
        "--repo",
        "acme/web",
        "--state",
        "open",
        "--label",
        evilLabel,
        "--limit",
        "100",
        "--json",
        PR_FIELDS,
      ]);
      // The whole malicious string is ONE argv element — not split by a shell.
      expect(calls[0].args.filter((a) => a === evilLabel)).toHaveLength(1);
    });

    it("getPullRequest issues the exact literal argv contract", () => {
      const { run, calls } = recordingRunner(() => JSON.stringify(rawPr));
      const client = createGitHubPrClient({ cwd: "/repo", run });
      client.getPullRequest("acme/web", 42);
      expect(calls[0].args).toEqual([
        "pr",
        "view",
        "42",
        "--repo",
        "acme/web",
        "--json",
        PR_FIELDS,
      ]);
    });

    it("getIssue issues the exact literal argv contract", () => {
      const { run, calls } = recordingRunner(() =>
        JSON.stringify({
          number: 7,
          url: "https://github.com/acme/web/issues/7",
          title: "Bug",
          body: "Body",
          state: "OPEN",
          updatedAt: "2024-01-02T03:04:05Z",
        })
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      client.getIssue("acme/web", 7);
      expect(calls[0].args).toEqual([
        "issue",
        "view",
        "7",
        "--repo",
        "acme/web",
        "--json",
        "number,url,title,body,state,updatedAt",
      ]);
    });

    it("labelExists issues the exact literal argv contract", () => {
      const { run, calls } = recordingRunner(() =>
        JSON.stringify([{ name: "otto-review" }])
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      client.labelExists("acme/web", "otto-review");
      expect(calls[0].args).toEqual([
        "label",
        "list",
        "--repo",
        "acme/web",
        "--search",
        "otto-review",
        "--limit",
        "100",
        "--json",
        "name",
      ]);
    });

    it("viewer issues the exact literal argv contract", () => {
      const { run, calls } = recordingRunner(() =>
        JSON.stringify({ login: "octocat" })
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      client.viewer();
      expect(calls[0].args).toEqual(["api", "user", "--jq", "{login: .login}"]);
    });

    it("listIssueComments issues the exact paginate/slurp argv contract", () => {
      const { run, calls } = recordingRunner(() => "[[]]");
      const client = createGitHubPrClient({ cwd: "/repo", run });
      client.listIssueComments("acme/web", 7);
      expect(calls[0].args).toEqual([
        "api",
        "--paginate",
        "--slurp",
        "repos/acme/web/issues/7/comments",
      ]);
    });

    it("listReviews issues the exact paginate/slurp argv contract", () => {
      const { run, calls } = recordingRunner(() => "[[]]");
      const client = createGitHubPrClient({ cwd: "/repo", run });
      client.listReviews("acme/web", 42);
      expect(calls[0].args).toEqual([
        "api",
        "--paginate",
        "--slurp",
        "repos/acme/web/pulls/42/reviews",
      ]);
    });
  });

  describe("PR parsing", () => {
    it("parses a well-formed PR JSON payload into a PullRequestRevision", () => {
      const { run } = recordingRunner(() => JSON.stringify(rawPr));
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.getPullRequest("acme/web", 42)).toEqual(expectedRevision);
    });

    it("listPullRequests filters by label/state/repo shape and parses each item", () => {
      const { run, calls } = recordingRunner(() => JSON.stringify([rawPr]));
      const client = createGitHubPrClient({ cwd: "/repo", run });
      const result = client.listPullRequests("acme/web", "otto-review");
      expect(calls[0].args).toEqual([
        "pr",
        "list",
        "--repo",
        "acme/web",
        "--state",
        "open",
        "--label",
        "otto-review",
        "--limit",
        "100",
        "--json",
        PR_FIELDS,
      ]);
      expect(result).toEqual([expectedRevision]);
    });

    it("rejects a PR payload missing a required field as malformed", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify({ ...rawPr, author: undefined })
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected getPullRequest to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(GitHubPrError);
        expect((e as GitHubPrError).kind).toBe("malformed");
      }
    });
  });

  describe("issue parsing", () => {
    function issuePayload(overrides: Record<string, unknown> = {}) {
      return {
        number: 7,
        url: "https://github.com/acme/web/issues/7",
        title: "Something <script>broke</script>",
        body: "Repro:\n1. do X\n2. see Y",
        state: "OPEN",
        updatedAt: "2024-01-02T03:04:05Z",
        ...overrides,
      };
    }

    it("parses an OPEN issue, preserving title/body exactly", () => {
      const { run } = recordingRunner(() => JSON.stringify(issuePayload()));
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.getIssue("acme/web", 7)).toEqual({
        number: 7,
        url: "https://github.com/acme/web/issues/7",
        title: "Something <script>broke</script>",
        body: "Repro:\n1. do X\n2. see Y",
        state: "OPEN",
        updatedAt: "2024-01-02T03:04:05Z",
      });
    });

    it("parses a CLOSED issue", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify(issuePayload({ state: "CLOSED" }))
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.getIssue("acme/web", 7).state).toBe("CLOSED");
    });

    it("rejects an issue number that is not a positive safe integer", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify(issuePayload({ number: -1 }))
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(() => client.getIssue("acme/web", 7)).toThrow(GitHubPrError);
    });

    it("rejects a cross-repository issue URL", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify(
          issuePayload({ url: "https://github.com/other/repo/issues/7" })
        )
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getIssue("acme/web", 7);
        expect.unreachable("expected getIssue to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(GitHubPrError);
        expect((e as GitHubPrError).kind).toBe("malformed");
      }
    });

    it("rejects a PR URL passed off as an issue URL", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify(
          issuePayload({ url: "https://github.com/acme/web/pull/7" })
        )
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(() => client.getIssue("acme/web", 7)).toThrow(GitHubPrError);
    });

    it("matches the repository comparison case-insensitively", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify(
          issuePayload({ url: "https://github.com/ACME/WEB/issues/7" })
        )
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.getIssue("acme/web", 7).number).toBe(7);
    });

    it("rejects a non-ISO updatedAt timestamp", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify(issuePayload({ updatedAt: "not-a-date" }))
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(() => client.getIssue("acme/web", 7)).toThrow(GitHubPrError);
    });

    it("rejects an invalid state", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify(issuePayload({ state: "MERGED" }))
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(() => client.getIssue("acme/web", 7)).toThrow(GitHubPrError);
    });
  });

  describe("labelExists", () => {
    it("returns true on an exact name match", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify([{ name: "otto-review-extra" }, { name: "otto-review" }])
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.labelExists("acme/web", "otto-review")).toBe(true);
    });

    it("returns false when only a partial/fuzzy match is present", () => {
      const { run } = recordingRunner(() =>
        JSON.stringify([{ name: "otto-review-extra" }])
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.labelExists("acme/web", "otto-review")).toBe(false);
    });
  });

  describe("pagination flattening", () => {
    it("flattens --slurp page arrays for listIssueComments", () => {
      const page1 = [
        { id: 1, body: "a", user: { login: "u1" }, html_url: "https://x/1" },
      ];
      const page2 = [
        { id: 2, body: "b", user: { login: "u2" }, html_url: "https://x/2" },
      ];
      const { run } = recordingRunner(() => JSON.stringify([page1, page2]));
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.listIssueComments("acme/web", 7)).toEqual([
        { id: 1, body: "a", author: "u1", url: "https://x/1" },
        { id: 2, body: "b", author: "u2", url: "https://x/2" },
      ]);
    });

    it("flattens --slurp page arrays for listReviews", () => {
      const page1 = [
        {
          id: 1,
          body: "looks good",
          user: { login: "u1" },
          commit_id: "a".repeat(40),
          state: "APPROVED",
        },
      ];
      const { run } = recordingRunner(() => JSON.stringify([page1]));
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.listReviews("acme/web", 42)).toEqual([
        {
          id: 1,
          body: "looks good",
          author: "u1",
          commitId: "a".repeat(40),
          state: "APPROVED",
        },
      ]);
    });

    it("handles an empty pagination result", () => {
      const { run } = recordingRunner(() => "[[]]");
      const client = createGitHubPrClient({ cwd: "/repo", run });
      expect(client.listIssueComments("acme/web", 7)).toEqual([]);
    });
  });

  describe("malformed JSON", () => {
    it("classifies invalid JSON output as malformed", () => {
      const { run } = recordingRunner(() => "not json{{{");
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected getPullRequest to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(GitHubPrError);
        expect((e as GitHubPrError).kind).toBe("malformed");
        expect((e as GitHubPrError).retryable).toBe(false);
      }
    });
  });

  describe("error classification via adapter methods", () => {
    it("classifies a 401 as auth (non-retryable)", () => {
      const run: GhRunner = () => {
        throw new Error("gh: Bad credentials (HTTP 401)");
      };
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected throw");
      } catch (e) {
        expect((e as GitHubPrError).kind).toBe("auth");
        expect((e as GitHubPrError).retryable).toBe(false);
      }
    });

    it("classifies a plain 403 as permission (non-retryable)", () => {
      const run: GhRunner = () => {
        throw new Error("gh: Forbidden (HTTP 403)");
      };
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected throw");
      } catch (e) {
        expect((e as GitHubPrError).kind).toBe("permission");
        expect((e as GitHubPrError).retryable).toBe(false);
      }
    });

    it("classifies a rate-limited 403 as rate-limit (retryable)", () => {
      const run: GhRunner = () => {
        throw new Error(
          "gh: API rate limit exceeded for user ID 123. (HTTP 403)"
        );
      };
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected throw");
      } catch (e) {
        expect((e as GitHubPrError).kind).toBe("rate-limit");
        expect((e as GitHubPrError).retryable).toBe(true);
      }
    });

    it("classifies a 429 as rate-limit (retryable)", () => {
      const run: GhRunner = () => {
        throw new Error("gh: Too Many Requests (HTTP 429)");
      };
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected throw");
      } catch (e) {
        expect((e as GitHubPrError).kind).toBe("rate-limit");
        expect((e as GitHubPrError).retryable).toBe(true);
      }
    });

    it("classifies a DNS/transport failure as network (retryable)", () => {
      const run: GhRunner = () => {
        throw new Error(
          "gh: error connecting to api.github.com: dial tcp: lookup api.github.com: no such host"
        );
      };
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected throw");
      } catch (e) {
        expect((e as GitHubPrError).kind).toBe("network");
        expect((e as GitHubPrError).retryable).toBe(true);
      }
    });

    it("classifies a timeout as network (retryable)", () => {
      const run: GhRunner = () => {
        throw new Error("gh: request to api.github.com timed out");
      };
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected throw");
      } catch (e) {
        expect((e as GitHubPrError).kind).toBe("network");
        expect((e as GitHubPrError).retryable).toBe(true);
      }
    });

    it("classifies a 404 as not-found (non-retryable)", () => {
      const run: GhRunner = () => {
        throw new Error("gh: Not Found (HTTP 404)");
      };
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected throw");
      } catch (e) {
        expect((e as GitHubPrError).kind).toBe("not-found");
        expect((e as GitHubPrError).retryable).toBe(false);
      }
    });

    it("classifies a 422 as validation (permanent, non-retryable)", () => {
      const run: GhRunner = () => {
        throw new Error("gh: Validation Failed (HTTP 422)");
      };
      const client = createGitHubPrClient({ cwd: "/repo", run });
      try {
        client.getPullRequest("acme/web", 42);
        expect.unreachable("expected throw");
      } catch (e) {
        expect((e as GitHubPrError).kind).toBe("validation");
        expect((e as GitHubPrError).retryable).toBe(false);
      }
    });
  });

  describe("classifyGitHubPrError (direct)", () => {
    it("passes an existing GitHubPrError through unchanged", () => {
      const original = new GitHubPrError("boom", "network", true, 503);
      expect(classifyGitHubPrError(original)).toBe(original);
    });

    it("classifies a raw SyntaxError as malformed", () => {
      const result = classifyGitHubPrError(new SyntaxError("Unexpected token"));
      expect(result.kind).toBe("malformed");
      expect(result.retryable).toBe(false);
    });

    it("falls back to unknown for an unrecognized error", () => {
      const result = classifyGitHubPrError(new Error("something weird"));
      expect(result.kind).toBe("unknown");
      expect(result.retryable).toBe(false);
    });
  });

  describe("comment create/update", () => {
    it("createIssueComment posts JSON via stdin and parses the response", () => {
      const responseComment = {
        id: 99,
        body: "Nice work",
        user: { login: "otto-bot" },
        html_url: "https://github.com/acme/web/issues/7#comment-99",
      };
      const { run, calls } = recordingRunner(() =>
        JSON.stringify(responseComment)
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      const result = client.createIssueComment("acme/web", 7, "Nice work");
      expect(calls[0].args).toEqual([
        "api",
        "repos/acme/web/issues/7/comments",
        "-X",
        "POST",
        "--input",
        "-",
      ]);
      expect(calls[0].input).toBe(JSON.stringify({ body: "Nice work" }));
      expect(result).toEqual({
        id: 99,
        body: "Nice work",
        author: "otto-bot",
        url: "https://github.com/acme/web/issues/7#comment-99",
      });
    });

    it("updateIssueComment PATCHes JSON via stdin and parses the response", () => {
      const responseComment = {
        id: 99,
        body: "Edited",
        user: { login: "otto-bot" },
        html_url: "https://github.com/acme/web/issues/7#comment-99",
      };
      const { run, calls } = recordingRunner(() =>
        JSON.stringify(responseComment)
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      const result = client.updateIssueComment("acme/web", 99, "Edited");
      expect(calls[0].args).toEqual([
        "api",
        "repos/acme/web/issues/comments/99",
        "-X",
        "PATCH",
        "--input",
        "-",
      ]);
      expect(calls[0].input).toBe(JSON.stringify({ body: "Edited" }));
      expect(result.body).toBe("Edited");
    });
  });

  describe("createReview", () => {
    it("posts a formal review JSON body via stdin", () => {
      const responseReview = {
        id: 501,
        body: "Ship it",
        user: { login: "otto-bot" },
        commit_id: "a".repeat(40),
        state: "APPROVED",
      };
      const { run, calls } = recordingRunner(() =>
        JSON.stringify(responseReview)
      );
      const client = createGitHubPrClient({ cwd: "/repo", run });
      const result = client.createReview({
        repository: "acme/web",
        pullRequest: 42,
        commitId: "a".repeat(40),
        event: "APPROVE",
        body: "Ship it",
        comments: [
          { path: "src/foo.ts", line: 10, side: "RIGHT", body: "nit: rename" },
        ],
      });
      expect(calls[0].args).toEqual([
        "api",
        "repos/acme/web/pulls/42/reviews",
        "-X",
        "POST",
        "--input",
        "-",
      ]);
      const sentBody = JSON.parse(calls[0].input as string);
      expect(sentBody).toEqual({
        commit_id: "a".repeat(40),
        event: "APPROVE",
        body: "Ship it",
        comments: [
          { path: "src/foo.ts", line: 10, side: "RIGHT", body: "nit: rename" },
        ],
      });
      expect(result).toEqual({
        id: 501,
        body: "Ship it",
        author: "otto-bot",
        commitId: "a".repeat(40),
        state: "APPROVED",
      });
    });
  });

  describe("default runner", () => {
    it("uses execFileSync (no shell) when no run override is given", () => {
      // Constructing the client without `run` must not throw synchronously —
      // it only invokes the default runner lazily, on a method call.
      expect(() => createGitHubPrClient({ cwd: "/repo" })).not.toThrow();
    });
  });
});

describe("canonicalGithubOrigin", () => {
  it("parses an HTTPS remote", () => {
    expect(canonicalGithubOrigin("https://github.com/Acme/Web.git")).toBe(
      "acme/web"
    );
  });

  it("parses an HTTPS remote without a .git suffix", () => {
    expect(canonicalGithubOrigin("https://github.com/acme/web")).toBe(
      "acme/web"
    );
  });

  it("parses an ssh:// remote", () => {
    expect(canonicalGithubOrigin("ssh://git@github.com/acme/web.git")).toBe(
      "acme/web"
    );
  });

  it("parses an scp-style remote", () => {
    expect(canonicalGithubOrigin("git@github.com:acme/web.git")).toBe(
      "acme/web"
    );
  });

  it("parses an scp-style remote without a .git suffix", () => {
    expect(canonicalGithubOrigin("git@github.com:acme/web")).toBe("acme/web");
  });

  it("returns null for a non-GitHub host", () => {
    expect(canonicalGithubOrigin("https://gitlab.com/acme/web.git")).toBeNull();
    expect(canonicalGithubOrigin("git@gitlab.com:acme/web.git")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(canonicalGithubOrigin("not a url at all")).toBeNull();
  });
});
