/**
 * Typed GitHub PR/issue adapter (P32 Task 4). This is the ONLY place that
 * invokes the `gh` CLI — every read/write the automated review feature needs
 * (PR + issue metadata, labels, comments, formal reviews) goes through
 * {@link createGitHubPrClient}. The model itself never touches `gh` directly.
 *
 * Every `gh` invocation is literal argv via `execFileSync` — never a shell —
 * so a shell metacharacter embedded in a label, ref, or comment body stays one
 * literal argv element and can never be shell-evaluated (mirrors task-key.ts's
 * `GhRunner` / gh-sub-issues.ts's `defaultGh`).
 */
import { execFileSync } from "node:child_process";

import type { PullRequestRevision } from "./pr-review.js";

// ---------------------------------------------------------------------------
// Runner injection
// ---------------------------------------------------------------------------

/** One `gh` invocation: literal argv, plus optional stdin (for JSON bodies). */
export type GhInvocation = {
  args: readonly string[];
  input?: string;
};

/** Injectable `gh` runner: returns stdout, or throws on a non-zero exit. */
export type GhRunner = (invocation: GhInvocation) => string;

/**
 * The real runner: `execFileSync` (no shell) so every argv element is passed
 * literally to the `gh` binary. `stdio: ["pipe","pipe","pipe"]` captures
 * stderr so {@link classifyGitHubPrError} can inspect gh's error text.
 */
function defaultGhRunner(cwd: string): GhRunner {
  return ({ args, input }) =>
    execFileSync("gh", [...args], {
      cwd,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type GitHubPrErrorKind =
  | "auth"
  | "permission"
  | "rate-limit"
  | "network"
  | "not-found"
  | "validation"
  | "malformed"
  | "unknown";

/** A classified GitHub adapter failure — callers branch on `kind`/`retryable`
 * rather than re-parsing error text. */
export class GitHubPrError extends Error {
  readonly kind: GitHubPrErrorKind;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    kind: GitHubPrErrorKind,
    retryable: boolean,
    status?: number
  ) {
    super(message);
    this.name = "GitHubPrError";
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
  }
}

/** Throw a `malformed` {@link GitHubPrError} for a missing/invalid field. */
function malformed(context: string, field: string): never {
  throw new GitHubPrError(
    `malformed ${context}: missing/invalid field "${field}"`,
    "malformed",
    false
  );
}

/** Pull stdout + stderr text out of whatever `run()`/`JSON.parse` threw. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const withStderr = error as Error & { stderr?: string | Buffer };
    const stderr =
      typeof withStderr.stderr === "string"
        ? withStderr.stderr
        : withStderr.stderr
          ? withStderr.stderr.toString("utf8")
          : "";
    return [error.message, stderr].filter(Boolean).join("\n");
  }
  return String(error);
}

const RATE_LIMIT_RE =
  /rate.?limit|secondary rate limit|abuse detection|\b429\b/i;
const AUTH_RE =
  /\b401\b|bad credentials|unauthoriz|authentication (?:failed|required)|requires authentication/i;
const NETWORK_RE =
  /enotfound|econnrefused|etimedout|econnreset|eai_again|epipe|getaddrinfo|dial tcp|could not resolve|network is unreachable|no such host|timed?\s*out/i;
const FORBIDDEN_RE = /\b403\b|forbidden/i;
const NOT_FOUND_RE = /\b404\b|not found/i;
const VALIDATION_RE = /\b422\b|validation failed|unprocessable entity/i;

/**
 * Classify an unknown thrown value (a `gh` exec failure, a JSON parse error,
 * or a schema-validation failure) into a {@link GitHubPrError}. Already-typed
 * {@link GitHubPrError}s (e.g. our own malformed-shape throws) pass through
 * unchanged, so every adapter method can catch once and call this uniformly.
 *
 * Classification rules (see task-4-brief.md): 401/auth hints → `auth`
 * (non-retryable); 403 without rate-limit text → `permission`
 * (non-retryable); 403/429/rate-limit text → `rate-limit` (retryable);
 * transport/DNS/timeout → `network` (retryable); 404 → `not-found`; 422 →
 * `validation` (permanent); JSON/schema failure → `malformed`.
 */
export function classifyGitHubPrError(error: unknown): GitHubPrError {
  if (error instanceof GitHubPrError) return error;
  if (error instanceof SyntaxError) {
    return new GitHubPrError(error.message, "malformed", false);
  }

  const text = errorText(error);
  const statusMatch = text.match(/HTTP\/?\s*(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  if (status === 401 || AUTH_RE.test(text)) {
    return new GitHubPrError(text, "auth", false, status ?? 401);
  }
  if (status === 429 || RATE_LIMIT_RE.test(text)) {
    return new GitHubPrError(text, "rate-limit", true, status ?? 429);
  }
  if (status === 403 || FORBIDDEN_RE.test(text)) {
    return new GitHubPrError(text, "permission", false, status ?? 403);
  }
  if (NETWORK_RE.test(text)) {
    return new GitHubPrError(text, "network", true, status);
  }
  if (status === 404 || NOT_FOUND_RE.test(text)) {
    return new GitHubPrError(text, "not-found", false, status ?? 404);
  }
  if (status === 422 || VALIDATION_RE.test(text)) {
    return new GitHubPrError(text, "validation", false, status ?? 422);
  }
  return new GitHubPrError(
    text || "GitHub request failed",
    "unknown",
    false,
    status
  );
}

/** Run `fn`, classifying and rethrowing any failure exactly once. */
function withGh<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw classifyGitHubPrError(e);
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new GitHubPrError(
      `malformed JSON from gh: ${(e as Error).message}`,
      "malformed",
      false
    );
  }
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type GitHubActor = { login: string };

export type GitHubIssueSpec = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
};

export type GitHubComment = {
  id: number;
  body: string;
  author: string;
  url: string;
};

export type GitHubReview = {
  id: number;
  body: string;
  author: string;
  commitId: string;
  state: string;
};

export type CreateGitHubReviewInput = {
  repository: string;
  pullRequest: number;
  commitId: string;
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  body: string;
  comments: {
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }[];
};

export type GitHubPrClient = {
  viewer(): GitHubActor;
  getPullRequest(repository: string, number: number): PullRequestRevision;
  getIssue(repository: string, number: number): GitHubIssueSpec;
  listPullRequests(repository: string, label: string): PullRequestRevision[];
  labelExists(repository: string, label: string): boolean;
  listIssueComments(repository: string, number: number): GitHubComment[];
  createIssueComment(
    repository: string,
    number: number,
    body: string
  ): GitHubComment;
  updateIssueComment(
    repository: string,
    commentId: number,
    body: string
  ): GitHubComment;
  listReviews(repository: string, number: number): GitHubReview[];
  createReview(input: CreateGitHubReviewInput): GitHubReview;
};

// ---------------------------------------------------------------------------
// Response parsing (malformed-input rejection)
// ---------------------------------------------------------------------------

const PR_JSON_FIELDS =
  "number,url,title,body,author,state,isDraft,labels,baseRefName,baseRefOid,headRefOid,files";
const ISSUE_JSON_FIELDS = "number,url,title,body,state,updatedAt";

type RawPr = {
  number?: unknown;
  url?: unknown;
  title?: unknown;
  body?: unknown;
  author?: { login?: unknown } | null;
  state?: unknown;
  isDraft?: unknown;
  labels?: unknown;
  baseRefName?: unknown;
  baseRefOid?: unknown;
  headRefOid?: unknown;
  files?: unknown;
};

function parsePrRevision(
  json: unknown,
  repository: string
): PullRequestRevision {
  const raw = (json ?? {}) as RawPr;
  const ctx = "PR JSON";

  if (
    typeof raw.number !== "number" ||
    !Number.isSafeInteger(raw.number) ||
    raw.number <= 0
  )
    malformed(ctx, "number");
  if (typeof raw.url !== "string" || raw.url.length === 0)
    malformed(ctx, "url");
  if (typeof raw.title !== "string") malformed(ctx, "title");
  if (typeof raw.body !== "string") malformed(ctx, "body");
  const authorLogin = raw.author?.login;
  if (typeof authorLogin !== "string" || authorLogin.length === 0)
    malformed(ctx, "author.login");
  if (raw.state !== "OPEN" && raw.state !== "CLOSED" && raw.state !== "MERGED")
    malformed(ctx, "state");
  if (typeof raw.isDraft !== "boolean") malformed(ctx, "isDraft");
  if (!Array.isArray(raw.labels)) malformed(ctx, "labels");
  const labels = (raw.labels as unknown[]).map((l, i) => {
    const name = (l as { name?: unknown })?.name;
    if (typeof name !== "string") malformed(ctx, `labels[${i}].name`);
    return name as string;
  });
  if (typeof raw.baseRefName !== "string") malformed(ctx, "baseRefName");
  if (typeof raw.baseRefOid !== "string") malformed(ctx, "baseRefOid");
  if (typeof raw.headRefOid !== "string") malformed(ctx, "headRefOid");
  if (!Array.isArray(raw.files)) malformed(ctx, "files");
  const changedFiles = (raw.files as unknown[]).map((f, i) => {
    const path = (f as { path?: unknown })?.path;
    if (typeof path !== "string") malformed(ctx, `files[${i}].path`);
    return path as string;
  });

  return {
    repository,
    number: raw.number as number,
    url: raw.url as string,
    title: raw.title as string,
    body: raw.body as string,
    author: authorLogin as string,
    state: raw.state as "OPEN" | "CLOSED" | "MERGED",
    isDraft: raw.isDraft as boolean,
    labels,
    baseRefName: raw.baseRefName as string,
    baseSha: raw.baseRefOid as string,
    headSha: raw.headRefOid as string,
    changedFiles,
  };
}

type RawIssue = {
  number?: unknown;
  url?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  updatedAt?: unknown;
};

// `https://github.com/owner/repo/issues/123[?...|#...]` — anchored so a PR URL
// (`/pull/`) or a cross-repo issue never silently parses as this repo's issue.
const ISSUE_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseIssueSpec(json: unknown, repository: string): GitHubIssueSpec {
  const raw = (json ?? {}) as RawIssue;
  const ctx = "issue JSON";

  if (
    typeof raw.number !== "number" ||
    !Number.isSafeInteger(raw.number) ||
    raw.number <= 0
  )
    malformed(ctx, "number");
  if (typeof raw.title !== "string") malformed(ctx, "title");
  if (typeof raw.body !== "string") malformed(ctx, "body");
  if (raw.state !== "OPEN" && raw.state !== "CLOSED") malformed(ctx, "state");
  if (
    typeof raw.updatedAt !== "string" ||
    !ISO_TIMESTAMP_RE.test(raw.updatedAt) ||
    Number.isNaN(Date.parse(raw.updatedAt))
  )
    malformed(ctx, "updatedAt");
  if (typeof raw.url !== "string") malformed(ctx, "url");

  const match = (raw.url as string).match(ISSUE_URL_RE);
  if (!match) malformed(ctx, "url");
  const [, owner, repo] = match as RegExpMatchArray;
  const canonical = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  if (canonical !== repository.toLowerCase()) {
    throw new GitHubPrError(
      `issue URL repository "${canonical}" does not match requested repository "${repository}"`,
      "malformed",
      false
    );
  }

  return {
    number: raw.number as number,
    url: raw.url as string,
    title: raw.title as string,
    body: raw.body as string,
    state: raw.state as "OPEN" | "CLOSED",
    updatedAt: raw.updatedAt as string,
  };
}

type RawComment = {
  id?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  html_url?: unknown;
};

function parseComment(json: unknown): GitHubComment {
  const raw = (json ?? {}) as RawComment;
  const ctx = "comment JSON";
  if (typeof raw.id !== "number") malformed(ctx, "id");
  if (typeof raw.body !== "string") malformed(ctx, "body");
  const login = raw.user?.login;
  if (typeof login !== "string") malformed(ctx, "user.login");
  if (typeof raw.html_url !== "string") malformed(ctx, "html_url");
  return {
    id: raw.id as number,
    body: raw.body as string,
    author: login as string,
    url: raw.html_url as string,
  };
}

type RawReview = {
  id?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  commit_id?: unknown;
  state?: unknown;
};

function parseReview(json: unknown): GitHubReview {
  const raw = (json ?? {}) as RawReview;
  const ctx = "review JSON";
  if (typeof raw.id !== "number") malformed(ctx, "id");
  if (typeof raw.body !== "string" && raw.body !== null) malformed(ctx, "body");
  const login = raw.user?.login;
  if (typeof login !== "string") malformed(ctx, "user.login");
  if (typeof raw.commit_id !== "string") malformed(ctx, "commit_id");
  if (typeof raw.state !== "string") malformed(ctx, "state");
  return {
    id: raw.id as number,
    body: (raw.body ?? "") as string,
    author: login as string,
    commitId: raw.commit_id as string,
    state: raw.state as string,
  };
}

/** Flatten a `--paginate --slurp` result: an array of per-page arrays. */
function flattenPages(json: unknown): unknown[] {
  if (!Array.isArray(json)) {
    malformed("paginated response", "<root> (expected array of pages)");
  }
  const out: unknown[] = [];
  for (const page of json as unknown[]) {
    if (!Array.isArray(page)) {
      malformed("paginated response", "page (expected array)");
    }
    out.push(...(page as unknown[]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// canonicalGithubOrigin
// ---------------------------------------------------------------------------

/**
 * Normalize a git remote URL to a lower-case `owner/repo` identity, or null
 * if it is not a GitHub remote. Handles HTTPS
 * (`https://github.com/owner/repo[.git]`), `ssh://git@github.com/owner/repo`,
 * and scp-style (`git@github.com:owner/repo.git`) forms.
 */
export function canonicalGithubOrigin(remoteUrl: string): string | null {
  const s = remoteUrl.trim();
  if (!s) return null;

  let host: string;
  let path: string;

  // scp-style: [user@]host:path — but NOT a `scheme://` URL (which also
  // contains a colon before the first slash).
  const scpMatch = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(s);
  if (scpMatch && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    host = scpMatch[1];
    path = scpMatch[2];
  } else {
    try {
      const u = new URL(s);
      host = u.hostname;
      path = u.pathname.replace(/^\//, "");
    } catch {
      return null;
    }
  }

  if (host.toLowerCase() !== "github.com") return null;

  const cleanPath = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Build the typed GitHub adapter. `run` defaults to a real `execFileSync`
 * runner bound to `cwd`; tests inject a fake to capture argv and simulate
 * responses/failures without ever invoking real `gh`.
 */
export function createGitHubPrClient(opts: {
  cwd: string;
  run?: GhRunner;
}): GitHubPrClient {
  const run = opts.run ?? defaultGhRunner(opts.cwd);
  const gh = (args: readonly string[], input?: string): string =>
    run({ args, input });

  return {
    viewer() {
      return withGh(() => {
        const out = gh(["api", "user", "--jq", "{login: .login}"]);
        const json = parseJson(out) as { login?: unknown };
        if (typeof json.login !== "string" || json.login.length === 0) {
          malformed("viewer JSON", "login");
        }
        return { login: json.login as string };
      });
    },

    getPullRequest(repository, number) {
      return withGh(() => {
        const out = gh([
          "pr",
          "view",
          String(number),
          "--repo",
          repository,
          "--json",
          PR_JSON_FIELDS,
        ]);
        return parsePrRevision(parseJson(out), repository);
      });
    },

    getIssue(repository, number) {
      return withGh(() => {
        const out = gh([
          "issue",
          "view",
          String(number),
          "--repo",
          repository,
          "--json",
          ISSUE_JSON_FIELDS,
        ]);
        return parseIssueSpec(parseJson(out), repository);
      });
    },

    listPullRequests(repository, label) {
      return withGh(() => {
        const out = gh([
          "pr",
          "list",
          "--repo",
          repository,
          "--state",
          "open",
          "--label",
          label,
          "--limit",
          "100",
          "--json",
          PR_JSON_FIELDS,
        ]);
        const json = parseJson(out);
        if (!Array.isArray(json)) malformed("PR list JSON", "<root>");
        return (json as unknown[]).map((item) =>
          parsePrRevision(item, repository)
        );
      });
    },

    labelExists(repository, label) {
      return withGh(() => {
        const out = gh([
          "label",
          "list",
          "--repo",
          repository,
          "--search",
          label,
          "--limit",
          "100",
          "--json",
          "name",
        ]);
        const json = parseJson(out);
        if (!Array.isArray(json)) malformed("label list JSON", "<root>");
        return (json as unknown[]).some((item) => {
          const name = (item as { name?: unknown })?.name;
          return typeof name === "string" && name === label;
        });
      });
    },

    listIssueComments(repository, number) {
      return withGh(() => {
        const out = gh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/issues/${number}/comments`,
        ]);
        return flattenPages(parseJson(out)).map(parseComment);
      });
    },

    createIssueComment(repository, number, body) {
      return withGh(() => {
        const out = gh(
          [
            "api",
            `repos/${repository}/issues/${number}/comments`,
            "-X",
            "POST",
            "--input",
            "-",
          ],
          JSON.stringify({ body })
        );
        return parseComment(parseJson(out));
      });
    },

    updateIssueComment(repository, commentId, body) {
      return withGh(() => {
        const out = gh(
          [
            "api",
            `repos/${repository}/issues/comments/${commentId}`,
            "-X",
            "PATCH",
            "--input",
            "-",
          ],
          JSON.stringify({ body })
        );
        return parseComment(parseJson(out));
      });
    },

    listReviews(repository, number) {
      return withGh(() => {
        const out = gh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/pulls/${number}/reviews`,
        ]);
        return flattenPages(parseJson(out)).map(parseReview);
      });
    },

    createReview(input) {
      return withGh(() => {
        const body = JSON.stringify({
          commit_id: input.commitId,
          event: input.event,
          body: input.body,
          comments: input.comments.map((c) => ({
            path: c.path,
            line: c.line,
            side: c.side,
            body: c.body,
          })),
        });
        const out = gh(
          [
            "api",
            `repos/${input.repository}/pulls/${input.pullRequest}/reviews`,
            "-X",
            "POST",
            "--input",
            "-",
          ],
          body
        );
        return parseReview(parseJson(out));
      });
    },
  };
}
