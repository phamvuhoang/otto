import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * A normalized Linear issue reference. Discriminated so callers know whether to
 * query Linear by its human identifier (`ENG-123`) or by the issue UUID.
 */
export type LinearRef =
  | { kind: "identifier"; identifier: string }
  | { kind: "uuid"; uuid: string };

// A Linear issue identifier: team key (letter then letters/digits) + "-" +
// positive number (no leading zero — mirrors parseIssueRef strictness).
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/;
// Issue UUID (RFC-4122 shape; we don't validate the version nibble).
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// `linear.app/<workspace>/issue/<IDENTIFIER>[/<slug>...]` — the identifier is
// the path segment after `/issue/`.
const URL_IDENTIFIER_RE = /\/issue\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)(?:[/?#]|$)/;

/**
 * Normalize a user-supplied Linear issue reference to a {@link LinearRef}.
 * Accepts a Linear identifier (`ENG-123`), an issue UUID, or a Linear issue
 * URL (`https://linear.app/acme/issue/ENG-123/slug`). Team keys are uppercased
 * to Linear's canonical form; UUIDs are lowercased. Throws on anything else.
 *
 * SECURITY: like {@link parseIssueRef} in cli-help.ts, the normalized value is
 * the only part of a ref that may reach a shell (via a static template command
 * reading an env var). The identifier/UUID regexes admit only `[A-Za-z0-9-]`,
 * so a value like `$(rm -rf ~)` can never survive parsing.
 */
export function parseLinearRef(raw: string): LinearRef {
  const s = raw.trim();

  const urlMatch = s.match(URL_IDENTIFIER_RE);
  if (urlMatch) {
    return { kind: "identifier", identifier: urlMatch[1].toUpperCase() };
  }
  if (UUID_RE.test(s)) {
    return { kind: "uuid", uuid: s.toLowerCase() };
  }
  if (IDENTIFIER_RE.test(s)) {
    return { kind: "identifier", identifier: s.toUpperCase() };
  }
  throw new Error(
    `--issue must be a Linear identifier (ENG-123), an issue UUID, or a Linear issue URL, got: ${JSON.stringify(raw)}`
  );
}

/**
 * Parse + canonicalize a `--issue` value to the single shell-safe string Otto
 * exports as `OTTO_ISSUE` for the Linear single-issue template. Identifiers are
 * uppercased, UUIDs lowercased; both admit only `[A-Za-z0-9-]`, so the result is
 * safe to interpolate into the static `otto-linear view "$OTTO_ISSUE"` command.
 * Throws (via {@link parseLinearRef}) on anything malformed.
 */
export function parseLinearIssueArg(raw: string): string {
  const ref = parseLinearRef(raw);
  return ref.kind === "uuid" ? ref.uuid : ref.identifier;
}

/** A resolved Linear credential plus where it came from (for `--print-config`). */
export type LinearAuth = { token: string; source: string };

/**
 * Injectable env/fs so {@link resolveLinearAuth} stays pure and unit-testable
 * without real env vars or a real home dir. Mirrors {@link PreflightProbes}.
 */
export type LinearAuthDeps = {
  env: NodeJS.ProcessEnv;
  /** Read a file's contents, or null if it is absent/unreadable. */
  readFile: (path: string) => string | null;
  /** Home directory holding the credential file. */
  home: string;
};

/** Canonical location of the stored Linear API key (outside any repo). */
export function linearConfigPath(home: string): string {
  return join(home, ".config", "otto", "linear.json");
}

const defaultAuthDeps: LinearAuthDeps = {
  env: process.env,
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  home: homedir(),
};

/**
 * Resolve a Linear API key with precedence `OTTO_LINEAR_API_KEY` →
 * `LINEAR_API_KEY` → `~/.config/otto/linear.json` (`{ "type": "apiKey",
 * "token": "..." }`). Returns the token and its source, or null when no source
 * yields a usable (non-empty) token. The config shape is kept extensible for a
 * future OAuth `type`.
 */
export function resolveLinearAuth(
  deps: LinearAuthDeps = defaultAuthDeps
): LinearAuth | null {
  const { env, readFile, home } = deps;

  for (const name of ["OTTO_LINEAR_API_KEY", "LINEAR_API_KEY"] as const) {
    const token = env[name]?.trim();
    if (token) return { token, source: name };
  }

  const path = linearConfigPath(home);
  const raw = readFile(path);
  if (raw != null) {
    try {
      const token = (JSON.parse(raw) as { token?: unknown }).token;
      if (typeof token === "string" && token.trim()) {
        return { token: token.trim(), source: path };
      }
    } catch {
      // malformed config → no credential from this source
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

/** Linear's GraphQL endpoint. */
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

/**
 * Why a Linear API call failed, so callers (notably watch-mode polling) can
 * distinguish a bad/missing credential from a transient network blip or a
 * malformed request. `auth` is surfaced specially by `--print-config`/`--watch`.
 */
export type LinearErrorKind = "auth" | "request" | "network";

/** A typed Linear API failure carrying a {@link LinearErrorKind}. */
export class LinearApiError extends Error {
  readonly kind: LinearErrorKind;
  readonly status?: number;
  constructor(message: string, kind: LinearErrorKind, status?: number) {
    super(message);
    this.name = "LinearApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** Minimal viewer identity returned by {@link LinearClient.whoami}. */
export type LinearViewer = { id: string; name: string; email: string };

/** A labelled open issue as returned by {@link LinearClient.listIssues}. */
export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  /** Workflow state name (e.g. "Todo"). */
  state: string;
};

/** One comment on an issue (author name flattened, never null). */
export type LinearComment = { author: string; body: string; createdAt: string };

/** Full issue detail returned by {@link LinearClient.viewIssue}. */
export type LinearIssueDetail = LinearIssueSummary & {
  description: string;
  comments: LinearComment[];
};

/** A team's workflow state (column), with its category `type` and ordering. */
export type LinearWorkflowState = {
  id: string;
  name: string;
  /** Workflow category: "completed", "started", "unstarted", "canceled", … */
  type: string;
  /** Ordering within the team's workflow; lower = earlier. */
  position: number;
};

export type LinearClientDeps = {
  token: string;
  /** Injectable for tests; defaults to the global `fetch` (Node 20+). */
  fetch?: typeof fetch;
  /** Overridable endpoint (tests/self-hosting); defaults to Linear's API. */
  endpoint?: string;
};

/** Narrow set of Linear GraphQL operations Otto needs. */
export type LinearClient = {
  whoami(): Promise<LinearViewer>;
  listIssues(opts: {
    label: string;
    team?: string;
    limit: number;
  }): Promise<LinearIssueSummary[]>;
  viewIssue(ref: LinearRef): Promise<LinearIssueDetail>;
  addComment(issueId: string, body: string): Promise<{ id: string }>;
  listWorkflowStates(team: string): Promise<LinearWorkflowState[]>;
  moveToDone(
    issueId: string,
    stateId: string
  ): Promise<{ id: string; state: string }>;
};

type GraphQLError = { message?: string; extensions?: { code?: string } };

function isAuthError(status: number, errors: GraphQLError[]): boolean {
  if (status === 401 || status === 403) return true;
  return errors.some(
    (e) =>
      /authenticat/i.test(e?.message ?? "") ||
      /^AUTHENTICATION/i.test(e?.extensions?.code ?? "")
  );
}

const ISSUE_FIELDS = `id identifier title url description state { name type }`;
const COMMENT_FIELDS = `comments { nodes { body createdAt user { name } } }`;

type RawComment = { body: string; createdAt: string; user: { name: string } | null };
type RawIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description?: string | null;
  state: { name: string; type: string };
  comments?: { nodes: RawComment[] };
};

function mapDetail(raw: RawIssue): LinearIssueDetail {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    description: raw.description ?? "",
    state: raw.state.name,
    comments: (raw.comments?.nodes ?? []).map((c) => ({
      author: c.user?.name ?? "unknown",
      body: c.body,
      createdAt: c.createdAt,
    })),
  };
}

/**
 * Build a Linear GraphQL client bound to one API key. Each method issues a
 * single GraphQL request over injectable `fetch`, authenticating with the
 * personal-API-key scheme (`Authorization: <key>`, no `Bearer`). Failures throw
 * a {@link LinearApiError} classified as `auth`/`request`/`network`.
 *
 * Ref→id resolution beyond {@link viewIssue} (e.g. resolving a done-state id)
 * is intentionally left to higher layers; these ops stay thin and 1:1 with the
 * underlying GraphQL operations so they are trivial to mock and reason about.
 */
export function createLinearClient(deps: LinearClientDeps): LinearClient {
  const fetchImpl = deps.fetch ?? fetch;
  const endpoint = deps.endpoint ?? LINEAR_ENDPOINT;
  const token = deps.token;

  async function request<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: token,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      throw new LinearApiError(
        `Linear request failed: ${(e as Error).message}`,
        "network"
      );
    }

    let json: { data?: T; errors?: GraphQLError[] } | undefined;
    try {
      json = (await res.json()) as typeof json;
    } catch {
      json = undefined;
    }

    const errors = json?.errors ?? [];
    if (!res.ok || errors.length > 0) {
      const kind = isAuthError(res.status, errors) ? "auth" : "request";
      const msg = errors[0]?.message ?? `HTTP ${res.status}`;
      throw new LinearApiError(`Linear GraphQL error: ${msg}`, kind, res.status);
    }
    return json!.data as T;
  }

  return {
    async whoami() {
      const data = await request<{ viewer: LinearViewer }>(
        `query { viewer { id name email } }`,
        {}
      );
      return data.viewer;
    },

    async listIssues({ label, team, limit }) {
      const filter: Record<string, unknown> = {
        labels: { some: { name: { eq: label } } },
        state: { type: { nin: ["completed", "canceled"] } },
      };
      if (team) filter.team = { key: { eq: team } };
      const data = await request<{
        issues: { nodes: RawIssue[] };
      }>(
        `query ListIssues($filter: IssueFilter!, $first: Int!) {
           issues(filter: $filter, first: $first) {
             nodes { id identifier title url state { name type } }
           }
         }`,
        { filter, first: limit }
      );
      return data.issues.nodes.map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        url: n.url,
        state: n.state.name,
      }));
    },

    async viewIssue(ref) {
      if (ref.kind === "uuid") {
        const data = await request<{ issue: RawIssue | null }>(
          `query ViewIssue($id: String!) {
             issue(id: $id) { ${ISSUE_FIELDS} ${COMMENT_FIELDS} }
           }`,
          { id: ref.uuid }
        );
        if (!data.issue) {
          throw new LinearApiError(
            `Linear issue not found: ${ref.uuid}`,
            "request"
          );
        }
        return mapDetail(data.issue);
      }
      const [, team, num] = ref.identifier.match(
        /^([A-Za-z][A-Za-z0-9]*)-([1-9]\d*)$/
      )!;
      const data = await request<{ issues: { nodes: RawIssue[] } }>(
        `query FindIssue($team: String!, $number: Float!) {
           issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
             nodes { ${ISSUE_FIELDS} ${COMMENT_FIELDS} }
           }
         }`,
        { team, number: Number(num) }
      );
      const node = data.issues.nodes[0];
      if (!node) {
        throw new LinearApiError(
          `Linear issue not found: ${ref.identifier}`,
          "request"
        );
      }
      return mapDetail(node);
    },

    async addComment(issueId, body) {
      const data = await request<{
        commentCreate: { success: boolean; comment: { id: string } };
      }>(
        `mutation AddComment($issueId: String!, $body: String!) {
           commentCreate(input: { issueId: $issueId, body: $body }) {
             success comment { id }
           }
         }`,
        { issueId, body }
      );
      return { id: data.commentCreate.comment.id };
    },

    async listWorkflowStates(team) {
      const data = await request<{
        workflowStates: { nodes: LinearWorkflowState[] };
      }>(
        `query WorkflowStates($team: String!) {
           workflowStates(filter: { team: { key: { eq: $team } } }, first: 100) {
             nodes { id name type position }
           }
         }`,
        { team }
      );
      return data.workflowStates.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        position: n.position,
      }));
    },

    async moveToDone(issueId, stateId) {
      const data = await request<{
        issueUpdate: { success: boolean; issue: RawIssue };
      }>(
        `mutation MoveToDone($id: String!, $stateId: String!) {
           issueUpdate(id: $id, input: { stateId: $stateId }) {
             success issue { id state { name type } }
           }
         }`,
        { id: issueId, stateId }
      );
      return { id: data.issueUpdate.issue.id, state: data.issueUpdate.issue.state.name };
    },
  };
}

/** Outcome of resolving the target "done" workflow state for an issue's team. */
export type DoneStateResolution =
  | { kind: "resolved"; state: LinearWorkflowState }
  | { kind: "ambiguous"; reason: string };

/**
 * Resolve which workflow state a completed issue should move to, given a team's
 * states and an optional preferred state name (`OTTO_LINEAR_DONE_STATE`):
 *
 *  1. If `preferredName` is set, the state whose name matches it
 *     (case-insensitively) wins; if none matches the result is `ambiguous` — we
 *     never silently pick a different state than the user named.
 *  2. Otherwise the first `type: "completed"` state by ascending `position`.
 *  3. If neither yields a state the result is `ambiguous`; callers should
 *     comment on the issue and leave a human to move it rather than guess.
 */
export function resolveDoneState(
  states: LinearWorkflowState[],
  preferredName?: string
): DoneStateResolution {
  const wanted = preferredName?.trim();
  if (wanted) {
    const match = states.find(
      (s) => s.name.toLowerCase() === wanted.toLowerCase()
    );
    if (match) return { kind: "resolved", state: match };
    const names = states.map((s) => s.name).join(", ") || "none";
    return {
      kind: "ambiguous",
      reason: `no workflow state named "${wanted}" (have: ${names})`,
    };
  }
  const completed = states
    .filter((s) => s.type === "completed")
    .sort((a, b) => a.position - b.position);
  if (completed.length === 0) {
    return {
      kind: "ambiguous",
      reason: 'no workflow state of type "completed"',
    };
  }
  return { kind: "resolved", state: completed[0] };
}
