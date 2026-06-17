import { homedir } from "node:os";
import { readFileSync } from "node:fs";

import {
  createLinearClient,
  parseLinearRef,
  resolveDoneState,
  resolveLinearAuth,
  LinearApiError,
  type LinearClient,
} from "./linear-api.js";

/**
 * Injectable host surface for {@link runLinear} so the bundled `linear` helper
 * stays pure-ish and unit-testable without touching the real home dir or the
 * network. {@link defaultLinearCliDeps} wires up the host.
 */
export type LinearCliDeps = {
  env: NodeJS.ProcessEnv;
  /** Home directory holding the credential file. */
  home: string;
  /** Read a file's contents, or null if it is absent/unreadable. */
  readFile: (path: string) => string | null;
  /** Print one line to stdout. */
  out: (msg: string) => void;
  /** Print one line to stderr. */
  err: (msg: string) => void;
  /** Build a Linear client for a resolved token; injectable for tests. */
  makeClient: (token: string) => LinearClient;
};

/** Host-wired defaults for {@link runLinear}. */
export const defaultLinearCliDeps: LinearCliDeps = {
  env: process.env,
  home: homedir(),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
  makeClient: (token) => createLinearClient({ token }),
};

const USAGE =
  "Usage: linear <list|dump|view <ref>|comment <ref> --body-file <path>|done <ref>> [--label <name>] [--team <key>] [--project <name>] [--limit <n>]";

/** Pull `--name <value>` flags out of argv, returning the flags + positionals. */
function parseFlags(argv: string[]): {
  flags: Record<string, string>;
  positionals: string[];
} {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[++i] ?? "";
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

/** Resolve label/team/project/limit from flags, falling back to env then defaults. */
function listOptions(
  flags: Record<string, string>,
  env: NodeJS.ProcessEnv
):
  | { label: string; team?: string; project?: string; limit: number }
  | { error: string } {
  const label = flags.label?.trim() || env.OTTO_LINEAR_LABEL?.trim() || "otto";
  const team = flags.team?.trim() || env.OTTO_LINEAR_TEAM?.trim() || undefined;
  const project =
    flags.project?.trim() || env.OTTO_LINEAR_PROJECT?.trim() || undefined;
  const limit = flags.limit != null ? Number(flags.limit) : 50;
  if (!Number.isInteger(limit) || limit <= 0) {
    return { error: `--limit must be a positive integer, got: ${flags.limit}` };
  }
  // Omit absent filters entirely so listIssues' `if (team)`/`if (project)`
  // guards stay clean and tests can assert the exact arg shape.
  const opts: { label: string; team?: string; project?: string; limit: number } =
    { label, limit };
  if (team) opts.team = team;
  if (project) opts.project = project;
  return opts;
}

/**
 * Drive the bundled `linear` helper CLI — Otto's thin Linear counterpart to the
 * system `gh`, used by the Linear templates and the agent. Resolves to the
 * process exit code so the bin wrapper can `process.exit(code)`.
 *
 * - `list`    — print labelled open issues (identifier/title/state/url).
 * - `dump`    — emit a JSON array of full issue detail (bodies + comments), for
 *   spilling into a prompt (parallel to `gh issue list --json …,body,comments`).
 * - `view`    — print one issue's full detail as JSON.
 * - `comment` — add a comment to an issue from `--body-file`.
 * - `done`    — move an issue to a completed workflow state, resolved via
 *   `OTTO_LINEAR_DONE_STATE` (by name) else the team's first `completed`-type
 *   state; exits non-zero (no move) when the target state is ambiguous.
 */
export async function runLinear(
  argv: string[],
  deps: LinearCliDeps = defaultLinearCliDeps
): Promise<number> {
  const [sub, ...rest] = argv;
  const { flags, positionals } = parseFlags(rest);

  // Validate args before touching credentials so usage errors stay exit 2.
  let ref: ReturnType<typeof parseLinearRef> | undefined;
  let listOpts:
    | { label: string; team?: string; project?: string; limit: number }
    | undefined;
  switch (sub) {
    case "list":
    case "dump": {
      const opts = listOptions(flags, deps.env);
      if ("error" in opts) {
        deps.err(opts.error);
        return 2;
      }
      listOpts = opts;
      break;
    }
    case "view":
    case "comment":
    case "done": {
      if (positionals.length === 0) {
        deps.err(USAGE);
        return 2;
      }
      try {
        ref = parseLinearRef(positionals[0]);
      } catch (e) {
        deps.err((e as Error).message);
        return 2;
      }
      if (sub === "comment" && !flags["body-file"]) {
        deps.err("comment requires --body-file <path>.");
        return 2;
      }
      break;
    }
    default:
      deps.err(USAGE);
      return 2;
  }

  const auth = resolveLinearAuth({
    env: deps.env,
    readFile: deps.readFile,
    home: deps.home,
  });
  if (!auth) {
    deps.err("Linear auth: not found — run `otto-linear-auth login`.");
    return 1;
  }
  const client = deps.makeClient(auth.token);

  try {
    switch (sub) {
      case "list": {
        const opts = listOpts!;
        const issues = await client.listIssues(opts);
        if (issues.length === 0) {
          deps.out(`No open Linear issues with label "${opts.label}".`);
          return 0;
        }
        for (const i of issues) {
          deps.out(`${i.identifier}\t${i.title}\t[${i.state}]\t${i.url}`);
        }
        return 0;
      }

      case "dump": {
        const opts = listOpts!;
        const summaries = await client.listIssues(opts);
        const details = [];
        for (const s of summaries) {
          details.push(
            await client.viewIssue({ kind: "identifier", identifier: s.identifier })
          );
        }
        deps.out(JSON.stringify(details, null, 2));
        return 0;
      }

      case "view": {
        const detail = await client.viewIssue(ref!);
        deps.out(JSON.stringify(detail, null, 2));
        return 0;
      }

      case "comment": {
        const body = deps.readFile(flags["body-file"]);
        if (body == null) {
          deps.err(`Could not read --body-file: ${flags["body-file"]}`);
          return 2;
        }
        if (body.trim() === "") {
          deps.err(`--body-file is empty: ${flags["body-file"]}`);
          return 2;
        }
        const issue = await client.viewIssue(ref!);
        await client.addComment(issue.id, body);
        deps.out(`Commented on ${issue.identifier}.`);
        return 0;
      }

      case "done": {
        const issue = await client.viewIssue(ref!);
        const team = issue.identifier.split("-")[0];
        const states = await client.listWorkflowStates(team);
        const resolution = resolveDoneState(
          states,
          deps.env.OTTO_LINEAR_DONE_STATE
        );
        if (resolution.kind === "ambiguous") {
          deps.err(
            `Cannot move ${issue.identifier} to a done state: ${resolution.reason}. ` +
              `Set OTTO_LINEAR_DONE_STATE or move it in Linear manually.`
          );
          return 3;
        }
        const moved = await client.moveToDone(issue.id, resolution.state.id);
        deps.out(`Moved ${issue.identifier} to ${moved.state}.`);
        return 0;
      }

      default:
        deps.err(USAGE);
        return 2;
    }
  } catch (e) {
    const kind = e instanceof LinearApiError ? ` (${e.kind})` : "";
    deps.err(`Linear error${kind}: ${(e as Error).message}`);
    return 1;
  }
}
