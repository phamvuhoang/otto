import { describe, expect, it } from "vitest";

import { resolveSubIssueList, type GhRunner } from "../gh-sub-issues.js";

/** Build a fake gh runner from a map of "joined argv" → stdout (or a thrower). */
function fakeGh(routes: Record<string, string | (() => never)>): GhRunner {
  return (args) => {
    const key = args.join(" ");
    const hit = routes[key];
    if (hit === undefined) throw new Error(`unexpected gh call: ${key}`);
    return typeof hit === "function" ? hit() : hit;
  };
}

const subIssuesArgs = (n: number) =>
  `api repos/o/r/issues/${n}/sub_issues --paginate --jq .[] | {number,state}`;
const viewBodyArgs = (n: number) => `issue view ${n} --repo o/r --json body`;
const viewStateArgs = (n: number) =>
  `issue view ${n} --repo o/r --json number,state`;

const opts = { repo: "o/r", cwd: "/tmp" };

describe("resolveSubIssueList", () => {
  it("returns native sub-issues in API order, parent skipped", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]:
        `{"number":2,"state":"open"}\n{"number":3,"state":"open"}\n`,
      [subIssuesArgs(2)]: "",
      [subIssuesArgs(3)]: "",
      // leaf children fall back to body lookup (empty body → no children).
      [viewBodyArgs(2)]: `{"body":""}`,
      [viewBodyArgs(3)]: `{"body":""}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([2, 3]);
  });

  it("recurses depth-first, grandchild before child", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: `{"number":2,"state":"open"}\n`,
      [subIssuesArgs(2)]: `{"number":4,"state":"open"}\n`,
      [subIssuesArgs(4)]: "",
      [viewBodyArgs(4)]: `{"body":""}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([4, 2]);
  });

  it("skips closed children and their subtree", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]:
        `{"number":2,"state":"closed"}\n{"number":3,"state":"open"}\n`,
      [subIssuesArgs(3)]: "",
      [viewBodyArgs(3)]: `{"body":""}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([3]);
  });

  it("returns [] when the target has children but all are closed", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: `{"number":2,"state":"closed"}\n`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([]);
  });

  it("falls back to [target] for a leaf with no children", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: "",
      [viewBodyArgs(1)]: `{"body":"no refs here"}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([1]);
  });

  it("parses a markdown task-list in document order when native is empty", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: "",
      [viewBodyArgs(1)]: JSON.stringify({
        body: "## Sub-issues\n- [ ] #9 — c\n- [x] #8 — b\n- [ ] #7 — a\nmention #99 not a task\n",
      }),
      // each ref's state resolved; nested expansion of each is a leaf.
      [viewStateArgs(9)]: `{"number":9,"state":"open"}`,
      [viewStateArgs(8)]: `{"number":8,"state":"closed"}`,
      [viewStateArgs(7)]: `{"number":7,"state":"open"}`,
      [subIssuesArgs(9)]: "",
      [viewBodyArgs(9)]: `{"body":""}`,
      [subIssuesArgs(7)]: "",
      [viewBodyArgs(7)]: `{"body":""}`,
    });
    // #8 is closed → skipped; #99 is a bare mention, not a task item.
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([9, 7]);
  });

  it("breaks cycles via the visited set", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: `{"number":2,"state":"open"}\n`,
      [subIssuesArgs(2)]: `{"number":1,"state":"open"}\n`,
      [viewBodyArgs(2)]: `{"body":""}`,
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([2]);
  });

  it("degrades a node whose gh call throws to a leaf", () => {
    const gh = fakeGh({
      [subIssuesArgs(1)]: `{"number":2,"state":"open"}\n`,
      [subIssuesArgs(2)]: () => {
        throw new Error("boom");
      },
      [viewBodyArgs(2)]: () => {
        throw new Error("boom");
      },
    });
    expect(resolveSubIssueList(1, { ...opts, gh })).toEqual([2]);
  });
});
