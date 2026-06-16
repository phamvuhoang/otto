import { describe, expect, it, vi } from "vitest";

import {
  createLinearClient,
  LinearApiError,
  linearConfigPath,
  parseLinearRef,
  parseLinearIssueArg,
  resolveDoneState,
  resolveLinearAuth,
  type LinearWorkflowState,
} from "../linear-api.js";

describe("parseLinearRef", () => {
  it("accepts a bare identifier", () => {
    expect(parseLinearRef("ENG-123")).toEqual({
      kind: "identifier",
      identifier: "ENG-123",
    });
  });
  it("uppercases the team key", () => {
    expect(parseLinearRef("eng-123")).toEqual({
      kind: "identifier",
      identifier: "ENG-123",
    });
  });
  it("accepts an alphanumeric team key", () => {
    expect(parseLinearRef("ENG2-7")).toEqual({
      kind: "identifier",
      identifier: "ENG2-7",
    });
  });
  it("accepts a Linear issue URL with a slug", () => {
    expect(
      parseLinearRef("https://linear.app/acme/issue/ENG-123/some-title-here")
    ).toEqual({ kind: "identifier", identifier: "ENG-123" });
  });
  it("accepts a Linear issue URL without a slug", () => {
    expect(parseLinearRef("https://linear.app/acme/issue/ENG-123")).toEqual({
      kind: "identifier",
      identifier: "ENG-123",
    });
  });
  it("uppercases the identifier extracted from a URL", () => {
    expect(parseLinearRef("https://linear.app/acme/issue/eng-9/x")).toEqual({
      kind: "identifier",
      identifier: "ENG-9",
    });
  });
  it("accepts an issue UUID and lowercases it", () => {
    expect(
      parseLinearRef("9BDA4F9E-1C2D-4E3F-8A9B-0C1D2E3F4A5B")
    ).toEqual({
      kind: "uuid",
      uuid: "9bda4f9e-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
    });
  });
  it("trims surrounding whitespace", () => {
    expect(parseLinearRef("  ENG-123  ")).toEqual({
      kind: "identifier",
      identifier: "ENG-123",
    });
  });
  it.each([
    "",
    "ENG",
    "ENG-",
    "-123",
    "ENG-0",
    "ENG-007",
    "123",
    "1ENG-2",
    "ENG_123",
    "ENG-12x",
    "$(rm -rf ~)",
    "ENG-12;rm",
    "ENG 12",
    "not-a-uuid-0000-0000-000000000000",
  ])("rejects %j", (bad) => {
    expect(() => parseLinearRef(bad)).toThrow();
  });
});

describe("parseLinearIssueArg", () => {
  it("canonicalizes an identifier ref to the uppercased identifier", () => {
    expect(parseLinearIssueArg("eng-12")).toBe("ENG-12");
  });
  it("canonicalizes a URL to its identifier", () => {
    expect(
      parseLinearIssueArg("https://linear.app/acme/issue/eng-9/slug")
    ).toBe("ENG-9");
  });
  it("canonicalizes a UUID ref to the lowercased UUID", () => {
    expect(parseLinearIssueArg("9BDA4F9E-1C2D-4E3F-8A9B-0C1D2E3F4A5B")).toBe(
      "9bda4f9e-1c2d-4e3f-8a9b-0c1d2e3f4a5b"
    );
  });
  it("returns only shell-safe characters (OTTO_ISSUE invariant)", () => {
    for (const raw of ["ENG-12", "9bda4f9e-1c2d-4e3f-8a9b-0c1d2e3f4a5b"]) {
      expect(parseLinearIssueArg(raw)).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });
  it("rejects a malformed ref (delegates to parseLinearRef)", () => {
    expect(() => parseLinearIssueArg("$(rm -rf ~)")).toThrow();
  });
});

describe("linearConfigPath", () => {
  it("resolves under ~/.config/otto/linear.json", () => {
    expect(linearConfigPath("/home/u")).toBe(
      "/home/u/.config/otto/linear.json"
    );
  });
});

describe("resolveLinearAuth", () => {
  const noFile = () => null;
  const filePath = "/home/u/.config/otto/linear.json";
  const fileWith = (token: unknown) => (p: string) =>
    p === filePath ? JSON.stringify({ type: "apiKey", token }) : null;

  it("prefers OTTO_LINEAR_API_KEY over everything", () => {
    expect(
      resolveLinearAuth({
        env: { OTTO_LINEAR_API_KEY: "otto-key", LINEAR_API_KEY: "linear-key" },
        readFile: fileWith("file-key"),
        home: "/home/u",
      })
    ).toEqual({ token: "otto-key", source: "OTTO_LINEAR_API_KEY" });
  });

  it("falls back to LINEAR_API_KEY when OTTO_LINEAR_API_KEY is unset", () => {
    expect(
      resolveLinearAuth({
        env: { LINEAR_API_KEY: "linear-key" },
        readFile: fileWith("file-key"),
        home: "/home/u",
      })
    ).toEqual({ token: "linear-key", source: "LINEAR_API_KEY" });
  });

  it("falls back to the config file when no env var is set", () => {
    expect(
      resolveLinearAuth({
        env: {},
        readFile: fileWith("file-key"),
        home: "/home/u",
      })
    ).toEqual({ token: "file-key", source: filePath });
  });

  it("returns null when no source has a credential", () => {
    expect(
      resolveLinearAuth({ env: {}, readFile: noFile, home: "/home/u" })
    ).toBeNull();
  });

  it("ignores empty/whitespace env vars and continues the precedence chain", () => {
    expect(
      resolveLinearAuth({
        env: { OTTO_LINEAR_API_KEY: "   ", LINEAR_API_KEY: "real" },
        readFile: noFile,
        home: "/home/u",
      })
    ).toEqual({ token: "real", source: "LINEAR_API_KEY" });
  });

  it("trims the resolved token", () => {
    expect(
      resolveLinearAuth({
        env: { OTTO_LINEAR_API_KEY: "  key  " },
        readFile: noFile,
        home: "/home/u",
      })
    ).toEqual({ token: "key", source: "OTTO_LINEAR_API_KEY" });
  });

  it("returns null when the config file is malformed JSON", () => {
    expect(
      resolveLinearAuth({
        env: {},
        readFile: () => "{ not json",
        home: "/home/u",
      })
    ).toBeNull();
  });

  it("returns null when the config file lacks a usable token", () => {
    expect(
      resolveLinearAuth({ env: {}, readFile: fileWith(""), home: "/home/u" })
    ).toBeNull();
    expect(
      resolveLinearAuth({
        env: {},
        readFile: fileWith(undefined),
        home: "/home/u",
      })
    ).toBeNull();
  });
});

describe("createLinearClient", () => {
  const ENDPOINT = "https://api.linear.app/graphql";

  // A fake `fetch` returning `payload` as JSON; records each call's parsed body.
  function fakeFetch(
    payload: unknown,
    { ok = true, status = 200, throws = false } = {}
  ) {
    const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      if (throws) throw new Error("ECONNREFUSED");
      calls.push({ url, init, body: JSON.parse(init.body as string) });
      return {
        ok,
        status,
        json: async () => payload,
      } as unknown as Response;
    });
    return { fn: fn as unknown as typeof fetch, calls };
  }

  it("whoami posts a viewer query with the API key as the auth header", async () => {
    const { fn, calls } = fakeFetch({
      data: { viewer: { id: "u1", name: "Ada", email: "a@b.c" } },
    });
    const client = createLinearClient({ token: "secret-key", fetch: fn });

    const me = await client.whoami();

    expect(me).toEqual({ id: "u1", name: "Ada", email: "a@b.c" });
    expect(calls[0].url).toBe(ENDPOINT);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "secret-key"
    );
    expect(calls[0].body.query).toContain("viewer");
  });

  it("listIssues filters by label, team and openness, maps nodes", async () => {
    const { fn, calls } = fakeFetch({
      data: {
        issues: {
          nodes: [
            {
              id: "i1",
              identifier: "ENG-1",
              title: "Do a thing",
              url: "https://linear.app/acme/issue/ENG-1",
              state: { name: "Todo", type: "unstarted" },
            },
          ],
        },
      },
    });
    const client = createLinearClient({ token: "k", fetch: fn });

    const issues = await client.listIssues({
      label: "otto",
      team: "ENG",
      limit: 10,
    });

    expect(issues).toEqual([
      {
        id: "i1",
        identifier: "ENG-1",
        title: "Do a thing",
        url: "https://linear.app/acme/issue/ENG-1",
        state: "Todo",
      },
    ]);
    const vars = calls[0].body.variables;
    expect(vars.first).toBe(10);
    expect(vars.filter.labels.some.name.eq).toBe("otto");
    expect(vars.filter.team.key.eq).toBe("ENG");
    expect(vars.filter.state.type.nin).toEqual(["completed", "canceled"]);
  });

  it("listIssues omits the team filter when no team is given", async () => {
    const { fn, calls } = fakeFetch({ data: { issues: { nodes: [] } } });
    const client = createLinearClient({ token: "k", fetch: fn });

    await client.listIssues({ label: "otto", limit: 50 });

    expect(calls[0].body.variables.filter.team).toBeUndefined();
  });

  it("viewIssue by UUID queries issue(id) and maps comments", async () => {
    const { fn, calls } = fakeFetch({
      data: {
        issue: {
          id: "i1",
          identifier: "ENG-1",
          title: "T",
          url: "u",
          description: "body text",
          state: { name: "Todo", type: "unstarted" },
          comments: {
            nodes: [
              { body: "first", createdAt: "2026-01-01", user: { name: "Ada" } },
              { body: "anon", createdAt: "2026-01-02", user: null },
            ],
          },
        },
      },
    });
    const client = createLinearClient({ token: "k", fetch: fn });

    const issue = await client.viewIssue({
      kind: "uuid",
      uuid: "9bda4f9e-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
    });

    expect(calls[0].body.variables.id).toBe(
      "9bda4f9e-1c2d-4e3f-8a9b-0c1d2e3f4a5b"
    );
    expect(issue).toEqual({
      id: "i1",
      identifier: "ENG-1",
      title: "T",
      url: "u",
      description: "body text",
      state: "Todo",
      comments: [
        { author: "Ada", body: "first", createdAt: "2026-01-01" },
        { author: "unknown", body: "anon", createdAt: "2026-01-02" },
      ],
    });
  });

  it("viewIssue by identifier filters on team key + number", async () => {
    const { fn, calls } = fakeFetch({
      data: {
        issues: {
          nodes: [
            {
              id: "i9",
              identifier: "ENG-123",
              title: "T",
              url: "u",
              description: "",
              state: { name: "Done", type: "completed" },
              comments: { nodes: [] },
            },
          ],
        },
      },
    });
    const client = createLinearClient({ token: "k", fetch: fn });

    const issue = await client.viewIssue({
      kind: "identifier",
      identifier: "ENG-123",
    });

    expect(calls[0].body.variables.team).toBe("ENG");
    expect(calls[0].body.variables.number).toBe(123);
    expect(issue.id).toBe("i9");
    expect(issue.comments).toEqual([]);
  });

  it("viewIssue throws when an identifier matches no issue", async () => {
    const { fn } = fakeFetch({ data: { issues: { nodes: [] } } });
    const client = createLinearClient({ token: "k", fetch: fn });

    await expect(
      client.viewIssue({ kind: "identifier", identifier: "ENG-404" })
    ).rejects.toThrow(/ENG-404/);
  });

  it("addComment mutates with the issue id and body", async () => {
    const { fn, calls } = fakeFetch({
      data: { commentCreate: { success: true, comment: { id: "c1" } } },
    });
    const client = createLinearClient({ token: "k", fetch: fn });

    const res = await client.addComment("i1", "hello world");

    expect(res).toEqual({ id: "c1" });
    expect(calls[0].body.query).toContain("commentCreate");
    expect(calls[0].body.variables).toEqual({
      issueId: "i1",
      body: "hello world",
    });
  });

  it("addComment throws a classified request error when the mutation fails", async () => {
    const { fn } = fakeFetch({
      data: { commentCreate: { success: false, comment: null } },
    });
    const client = createLinearClient({ token: "k", fetch: fn });

    await expect(client.addComment("i1", "hello")).rejects.toMatchObject({
      kind: "request",
    });
  });

  it("moveToDone updates the issue state and returns the new state name", async () => {
    const { fn, calls } = fakeFetch({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "i1", state: { name: "Done", type: "completed" } },
        },
      },
    });
    const client = createLinearClient({ token: "k", fetch: fn });

    const res = await client.moveToDone("i1", "state-done");

    expect(res).toEqual({ id: "i1", state: "Done" });
    expect(calls[0].body.query).toContain("issueUpdate");
    expect(calls[0].body.variables).toEqual({
      id: "i1",
      stateId: "state-done",
    });
  });

  it("moveToDone throws a classified request error when the mutation fails", async () => {
    const { fn } = fakeFetch({
      data: { issueUpdate: { success: false, issue: null } },
    });
    const client = createLinearClient({ token: "k", fetch: fn });

    await expect(client.moveToDone("i1", "state-done")).rejects.toMatchObject({
      kind: "request",
    });
  });

  it("listWorkflowStates filters by team key and maps id/name/type/position", async () => {
    const { fn, calls } = fakeFetch({
      data: {
        workflowStates: {
          nodes: [
            { id: "s1", name: "Todo", type: "unstarted", position: 0 },
            { id: "s2", name: "Done", type: "completed", position: 2 },
          ],
        },
      },
    });
    const client = createLinearClient({ token: "k", fetch: fn });

    const states = await client.listWorkflowStates("ENG");

    expect(states).toEqual([
      { id: "s1", name: "Todo", type: "unstarted", position: 0 },
      { id: "s2", name: "Done", type: "completed", position: 2 },
    ]);
    expect(calls[0].body.query).toContain("workflowStates");
    expect(calls[0].body.variables.team).toBe("ENG");
  });

  it("classifies an HTTP 401 as an auth error", async () => {
    const { fn } = fakeFetch(
      { errors: [{ message: "Authentication required" }] },
      { ok: false, status: 401 }
    );
    const client = createLinearClient({ token: "bad", fetch: fn });

    await expect(client.whoami()).rejects.toMatchObject({
      name: "LinearApiError",
      kind: "auth",
      status: 401,
    });
  });

  it("classifies a GraphQL authentication error as an auth error", async () => {
    const { fn } = fakeFetch({
      errors: [
        { message: "nope", extensions: { code: "AUTHENTICATION_ERROR" } },
      ],
    });
    const client = createLinearClient({ token: "bad", fetch: fn });

    const err = await client.whoami().catch((e) => e);
    expect(err).toBeInstanceOf(LinearApiError);
    expect(err.kind).toBe("auth");
  });

  it("classifies a non-auth GraphQL error as a request error", async () => {
    const { fn } = fakeFetch({ errors: [{ message: "bad filter" }] });
    const client = createLinearClient({ token: "k", fetch: fn });

    await expect(client.whoami()).rejects.toMatchObject({
      kind: "request",
    });
  });

  it("wraps a fetch network failure as a network error", async () => {
    const { fn } = fakeFetch(null, { throws: true });
    const client = createLinearClient({ token: "k", fetch: fn });

    await expect(client.whoami()).rejects.toMatchObject({
      kind: "network",
    });
  });
});

describe("resolveDoneState", () => {
  const states: LinearWorkflowState[] = [
    { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
    { id: "s-prog", name: "In Progress", type: "started", position: 1 },
    { id: "s-rel", name: "Released", type: "completed", position: 3 },
    { id: "s-done", name: "Done", type: "completed", position: 2 },
    { id: "s-cancel", name: "Canceled", type: "canceled", position: 4 },
  ];

  it("prefers a state named OTTO_LINEAR_DONE_STATE (case-insensitive)", () => {
    expect(resolveDoneState(states, "released")).toEqual({
      kind: "resolved",
      state: { id: "s-rel", name: "Released", type: "completed", position: 3 },
    });
  });

  it("is ambiguous when the named state does not exist", () => {
    const res = resolveDoneState(states, "Shipped");
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.reason).toMatch(/Shipped/);
  });

  it("falls back to the first completed state by position", () => {
    expect(resolveDoneState(states)).toEqual({
      kind: "resolved",
      state: { id: "s-done", name: "Done", type: "completed", position: 2 },
    });
  });

  it("ignores a blank preferred name and falls back to a completed state", () => {
    expect(resolveDoneState(states, "   ").kind).toBe("resolved");
  });

  it("is ambiguous when no completed state exists", () => {
    const noneDone = states.filter((s) => s.type !== "completed");
    const res = resolveDoneState(noneDone);
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") expect(res.reason).toMatch(/completed/);
  });
});
