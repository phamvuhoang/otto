import { describe, expect, it, vi } from "vitest";

import { runLinear, type LinearCliDeps } from "../linear-cli.js";
import {
  LinearApiError,
  type LinearClient,
  type LinearIssueDetail,
  type LinearIssueSummary,
} from "../linear-api.js";

const SUMMARY: LinearIssueSummary = {
  id: "uuid-1",
  identifier: "ENG-123",
  title: "Wire the widget",
  url: "https://linear.app/acme/issue/ENG-123/wire-the-widget",
  state: "Todo",
};

const DETAIL: LinearIssueDetail = {
  ...SUMMARY,
  description: "Full body of the issue.",
  comments: [
    { author: "Ada", body: "first comment", createdAt: "2026-06-16T00:00:00Z" },
  ],
};

/** A fully-stubbed client; override the op under test. */
function fakeClient(over: Partial<LinearClient> = {}): LinearClient {
  return {
    whoami: async () => ({ id: "u1", name: "Ada", email: "a@b.c" }),
    listIssues: async () => [SUMMARY],
    viewIssue: async () => DETAIL,
    addComment: async () => ({ id: "comment-1" }),
    moveToDone: async () => ({ id: "uuid-1", state: "Done" }),
    listWorkflowStates: async () => [
      { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
      { id: "s-done", name: "Done", type: "completed", position: 1 },
    ],
    ...over,
  };
}

function harness(over: Partial<LinearCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: LinearCliDeps = {
    env: { OTTO_LINEAR_API_KEY: "tok" },
    home: "/home/u",
    readFile: () => null,
    out: (m) => out.push(m),
    err: (m) => err.push(m),
    makeClient: () => fakeClient(),
    ...over,
  };
  return { deps, out, err };
}

describe("runLinear auth gate", () => {
  it("returns 1 and points at login when no credential resolves", async () => {
    const { deps, err } = harness({ env: {}, readFile: () => null });
    const code = await runLinear(["list"], deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/otto-linear-auth login/);
  });

  it("builds the client with the resolved token", async () => {
    const makeClient = vi.fn(() => fakeClient());
    const { deps } = harness({ makeClient });
    await runLinear(["list"], deps);
    expect(makeClient).toHaveBeenCalledWith("tok");
  });
});

describe("runLinear list", () => {
  it("lists labelled issues with default label/limit and prints identifiers", async () => {
    const listIssues = vi.fn(async () => [SUMMARY]);
    const { deps, out } = harness({ makeClient: () => fakeClient({ listIssues }) });

    const code = await runLinear(["list"], deps);

    expect(code).toBe(0);
    expect(listIssues).toHaveBeenCalledWith({ label: "otto", limit: 50 });
    expect(out.join("\n")).toContain("ENG-123");
    expect(out.join("\n")).toContain("Wire the widget");
  });

  it("passes --label, --team and --limit through to listIssues", async () => {
    const listIssues = vi.fn(async () => []);
    const { deps } = harness({ makeClient: () => fakeClient({ listIssues }) });

    await runLinear(["list", "--label", "bug", "--team", "ENG", "--limit", "10"], deps);

    expect(listIssues).toHaveBeenCalledWith({ label: "bug", team: "ENG", limit: 10 });
  });

  it("defaults the label from OTTO_LINEAR_LABEL and team from OTTO_LINEAR_TEAM", async () => {
    const listIssues = vi.fn(async () => []);
    const { deps } = harness({
      env: { OTTO_LINEAR_API_KEY: "tok", OTTO_LINEAR_LABEL: "triage", OTTO_LINEAR_TEAM: "OPS" },
      makeClient: () => fakeClient({ listIssues }),
    });

    await runLinear(["list"], deps);

    expect(listIssues).toHaveBeenCalledWith({ label: "triage", team: "OPS", limit: 50 });
  });

  it("reports cleanly when there are no matching issues", async () => {
    const { deps, out } = harness({
      makeClient: () => fakeClient({ listIssues: async () => [] }),
    });
    const code = await runLinear(["list"], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/no .*issues/i);
  });

  it("rejects a non-numeric --limit with exit 2", async () => {
    const { deps, err } = harness();
    const code = await runLinear(["list", "--limit", "lots"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/limit/i);
  });
});

describe("runLinear dump", () => {
  it("views each listed issue and emits a JSON array with bodies and comments", async () => {
    const viewIssue = vi.fn(async () => DETAIL);
    const { deps, out } = harness({
      makeClient: () => fakeClient({ listIssues: async () => [SUMMARY], viewIssue }),
    });

    const code = await runLinear(["dump"], deps);

    expect(code).toBe(0);
    expect(viewIssue).toHaveBeenCalledWith({ kind: "identifier", identifier: "ENG-123" });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].description).toBe("Full body of the issue.");
    expect(parsed[0].comments[0].body).toBe("first comment");
  });

  it("emits an empty JSON array when nothing matches", async () => {
    const { deps, out } = harness({
      makeClient: () => fakeClient({ listIssues: async () => [] }),
    });
    const code = await runLinear(["dump"], deps);
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual([]);
  });
});

describe("runLinear view", () => {
  it("views the parsed ref and prints the full detail as JSON", async () => {
    const viewIssue = vi.fn(async () => DETAIL);
    const { deps, out } = harness({ makeClient: () => fakeClient({ viewIssue }) });

    const code = await runLinear(["view", "eng-123"], deps);

    expect(code).toBe(0);
    expect(viewIssue).toHaveBeenCalledWith({ kind: "identifier", identifier: "ENG-123" });
    expect(JSON.parse(out.join("\n")).identifier).toBe("ENG-123");
  });

  it("returns 2 on a missing ref", async () => {
    const { deps, err } = harness();
    const code = await runLinear(["view"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/usage|issue/i);
  });

  it("returns 2 on a malformed ref", async () => {
    const { deps, err } = harness();
    const code = await runLinear(["view", "$(rm -rf ~)"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/identifier|uuid|url/i);
  });
});

describe("runLinear comment", () => {
  it("reads the body file, resolves the issue id, and adds the comment", async () => {
    const viewIssue = vi.fn(async () => DETAIL);
    const addComment = vi.fn(async () => ({ id: "comment-1" }));
    const { deps, out } = harness({
      readFile: (p) => (p === "/tmp/body.md" ? "the comment body" : null),
      makeClient: () => fakeClient({ viewIssue, addComment }),
    });

    const code = await runLinear(
      ["comment", "ENG-123", "--body-file", "/tmp/body.md"],
      deps
    );

    expect(code).toBe(0);
    expect(addComment).toHaveBeenCalledWith("uuid-1", "the comment body");
    expect(out.join("\n")).toContain("ENG-123");
  });

  it("returns 2 when --body-file is missing", async () => {
    const { deps, err } = harness();
    const code = await runLinear(["comment", "ENG-123"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/body-file/i);
  });

  it("returns 2 when the body file cannot be read", async () => {
    const { deps, err } = harness({ readFile: () => null });
    const code = await runLinear(
      ["comment", "ENG-123", "--body-file", "/tmp/missing.md"],
      deps
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/body-file|read/i);
  });
});

describe("runLinear done", () => {
  it("resolves the team's done state and moves the issue", async () => {
    const moveToDone = vi.fn(async () => ({ id: "uuid-1", state: "Done" }));
    const listWorkflowStates = vi.fn(async () => [
      { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
      { id: "s-done", name: "Done", type: "completed", position: 1 },
    ]);
    const { deps, out } = harness({
      makeClient: () => fakeClient({ moveToDone, listWorkflowStates }),
    });

    const code = await runLinear(["done", "ENG-123"], deps);

    expect(code).toBe(0);
    expect(listWorkflowStates).toHaveBeenCalledWith("ENG");
    expect(moveToDone).toHaveBeenCalledWith("uuid-1", "s-done");
    expect(out.join("\n")).toMatch(/ENG-123.*Done/);
  });

  it("honors OTTO_LINEAR_DONE_STATE by name", async () => {
    const moveToDone = vi.fn(async () => ({ id: "uuid-1", state: "Shipped" }));
    const { deps } = harness({
      env: { OTTO_LINEAR_API_KEY: "tok", OTTO_LINEAR_DONE_STATE: "Shipped" },
      makeClient: () =>
        fakeClient({
          moveToDone,
          listWorkflowStates: async () => [
            { id: "s-done", name: "Done", type: "completed", position: 1 },
            { id: "s-ship", name: "Shipped", type: "completed", position: 2 },
          ],
        }),
    });

    await runLinear(["done", "ENG-123"], deps);

    expect(moveToDone).toHaveBeenCalledWith("uuid-1", "s-ship");
  });

  it("does not move and exits non-zero when the done state is ambiguous", async () => {
    const moveToDone = vi.fn(async () => ({ id: "uuid-1", state: "Done" }));
    const { deps, err } = harness({
      makeClient: () =>
        fakeClient({
          moveToDone,
          listWorkflowStates: async () => [
            { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
          ],
        }),
    });

    const code = await runLinear(["done", "ENG-123"], deps);

    expect(code).not.toBe(0);
    expect(moveToDone).not.toHaveBeenCalled();
    expect(err.join("\n")).toMatch(/OTTO_LINEAR_DONE_STATE|done state/i);
  });

  it("returns 2 on a missing ref", async () => {
    const { deps, err } = harness();
    const code = await runLinear(["done"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/usage|issue/i);
  });

  it("returns 2 on a malformed ref", async () => {
    const { deps, err } = harness();
    const code = await runLinear(["done", "$(rm -rf ~)"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/identifier|uuid|url/i);
  });
});

describe("runLinear error handling", () => {
  it("maps a LinearApiError to exit 1 and surfaces its kind", async () => {
    const { deps, err } = harness({
      makeClient: () =>
        fakeClient({
          listIssues: async () => {
            throw new LinearApiError("bad key", "auth", 401);
          },
        }),
    });
    const code = await runLinear(["list"], deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/auth|bad key/i);
  });

  it("returns 2 on an unknown subcommand", async () => {
    const { deps, err } = harness();
    const code = await runLinear(["frobnicate"], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/list|dump|view|comment/);
  });

  it("returns 2 when no subcommand is given", async () => {
    const { deps, err } = harness();
    const code = await runLinear([], deps);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/usage/i);
  });
});
