import { execFileSync } from "node:child_process";

/** A GitHub issue reference with just the fields the resolver needs. */
export type IssueRef = { number: number; state: "open" | "closed" };

/** Injectable `gh` runner: takes argv (no shell), returns stdout. Tests pass a
 *  fake; production uses {@link defaultGh}. */
export type GhRunner = (args: string[]) => string;

/** Real runner: `execFileSync` (no shell) so values are literal argv entries —
 *  a ref like `$(rm -rf ~)` can never be shell-evaluated. Mirrors watch.ts. */
const defaultGh =
  (cwd: string): GhRunner =>
  (args) =>
    execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

/** Parse `gh api … --jq '.[] | {number,state}'` output: one JSON object per
 *  line (gh applies --jq per page, so --paginate stays newline-delimited). */
function parseRefLines(out: string): IssueRef[] {
  const refs: IssueRef[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { number?: unknown; state?: unknown };
      if (
        typeof o.number === "number" &&
        (o.state === "open" || o.state === "closed")
      ) {
        refs.push({ number: o.number, state: o.state });
      }
    } catch {
      // skip a malformed line rather than abort the whole resolution.
    }
  }
  return refs;
}

// A GitHub task-list item that references an issue: "- [ ] #123" / "- [x] #123"
// (also accepts "* "). Captures the issue number. A bare "#123" mention in prose
// is intentionally NOT matched.
const TASK_LIST_RE = /^\s*[-*] \[[ xX]\] +#(\d+)\b/;

/** Direct children of `n`: native sub_issues first, markdown task-list fallback.
 *  Never throws — a gh failure yields an empty list (node treated as a leaf). */
function directChildren(
  n: number,
  repo: string | undefined,
  gh: GhRunner
): IssueRef[] {
  const repoPath = repo ?? "{owner}/{repo}";
  const repoArg = repo ? ["--repo", repo] : [];

  // 1. Native GitHub sub-issues.
  try {
    const out = gh([
      "api",
      `repos/${repoPath}/issues/${n}/sub_issues`,
      "--paginate",
      "--jq",
      ".[] | {number,state}",
    ]);
    const native = parseRefLines(out);
    if (native.length > 0) return native;
  } catch {
    // fall through to the markdown fallback.
  }

  // 2. Markdown task-list fallback: parse the parent body in document order.
  let body = "";
  try {
    const out = gh(["issue", "view", String(n), ...repoArg, "--json", "body"]);
    body = (JSON.parse(out) as { body?: string }).body ?? "";
  } catch {
    return [];
  }
  const seen = new Set<number>();
  const nums: number[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(TASK_LIST_RE);
    if (!m) continue;
    const num = Number.parseInt(m[1], 10);
    if (Number.isInteger(num) && num > 0 && !seen.has(num)) {
      seen.add(num);
      nums.push(num);
    }
  }

  // Resolve each referenced issue's state (markdown carries no state).
  const refs: IssueRef[] = [];
  for (const num of nums) {
    try {
      const out = gh([
        "issue",
        "view",
        String(num),
        ...repoArg,
        "--json",
        "number,state",
      ]);
      const o = JSON.parse(out) as { number?: unknown; state?: unknown };
      const state = String(o.state ?? "").toLowerCase();
      if (
        typeof o.number === "number" &&
        (state === "open" || state === "closed")
      ) {
        refs.push({ number: o.number, state });
      }
    } catch {
      // unresolvable ref → skip it.
    }
  }
  return refs;
}

/**
 * Resolve the ordered list of issue numbers to process for `target`.
 * Recursive depth-first (leaves-first), native sub_issues then markdown
 * task-list fallback, only OPEN issues, parent skipped, cycle-guarded.
 * A leaf target (no children) returns `[target]` so single-issue behavior is
 * preserved; a target whose children are all closed returns `[]`.
 */
export function resolveSubIssueList(
  target: number,
  opts: { repo?: string; cwd: string; gh?: GhRunner }
): number[] {
  const gh = opts.gh ?? defaultGh(opts.cwd);
  const visited = new Set<number>([target]);
  const out: number[] = [];

  const visitChildren = (children: IssueRef[]): void => {
    for (const child of children) {
      if (child.state !== "open") continue; // closed subtree = done, skip.
      if (visited.has(child.number)) continue; // cycle / already queued.
      visited.add(child.number);
      visitChildren(directChildren(child.number, opts.repo, gh)); // depth-first.
      out.push(child.number); // child after its descendants (leaves-first).
    }
  };

  const targetChildren = directChildren(target, opts.repo, gh);
  if (targetChildren.length === 0) return [target]; // leaf → single-issue.
  visitChildren(targetChildren);
  return out; // may be [] if every child (and subtree) was closed.
}
