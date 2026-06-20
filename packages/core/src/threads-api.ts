/**
 * Threads (Meta) publishing client for the P12 public journal (issue #67).
 * Mirrors linear-api.ts: injectable fetch + credentials from env or
 * ~/.config/otto/threads.json. The Threads Graph API publishes in two steps —
 * create a TEXT container, then publish it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThreadsAuth = { token: string; userId: string; source: string };

export type ThreadsAuthDeps = {
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => string | null;
  home: string;
};

const defaultAuthDeps: ThreadsAuthDeps = {
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

/** Canonical location of the stored Threads credentials (outside any repo). */
export function threadsConfigPath(home: string): string {
  return join(home, ".config", "otto", "threads.json");
}

/**
 * Resolve a Threads token + user id with precedence `OTTO_THREADS_TOKEN` +
 * `OTTO_THREADS_USER_ID` → `~/.config/otto/threads.json` (`{ token, userId }`).
 * Returns null when no source yields both a token and a user id.
 */
export function resolveThreadsAuth(
  deps: ThreadsAuthDeps = defaultAuthDeps
): ThreadsAuth | null {
  const token = deps.env.OTTO_THREADS_TOKEN?.trim();
  const userId = deps.env.OTTO_THREADS_USER_ID?.trim();
  if (token && userId) return { token, userId, source: "env" };

  const path = threadsConfigPath(deps.home);
  const raw = deps.readFile(path);
  if (raw != null) {
    try {
      const o = JSON.parse(raw) as { token?: unknown; userId?: unknown };
      if (
        typeof o.token === "string" &&
        o.token.trim() &&
        typeof o.userId === "string" &&
        o.userId.trim()
      ) {
        return { token: o.token.trim(), userId: o.userId.trim(), source: path };
      }
    } catch {
      // malformed → no credential from this source
    }
  }
  return null;
}

export type ThreadsErrorKind = "auth" | "network" | "api";

export class ThreadsApiError extends Error {
  kind: ThreadsErrorKind;
  constructor(message: string, kind: ThreadsErrorKind) {
    super(message);
    this.name = "ThreadsApiError";
    this.kind = kind;
  }
}

export type ThreadsClient = { publish(text: string): Promise<{ id: string }> };

const DEFAULT_BASE = "https://graph.threads.net/v1.0";

/**
 * Create a Threads client. The two-step publish: create a TEXT container
 * (`/{userId}/threads`), then publish it (`/{userId}/threads_publish`). `fetch`
 * is injectable for tests; errors are classified as auth/network/api.
 */
export function createThreadsClient(opts: {
  token: string;
  userId: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}): ThreadsClient {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? DEFAULT_BASE;
  if (!opts.token || !opts.userId) {
    throw new ThreadsApiError("missing Threads credentials", "auth");
  }

  const post = async (url: string): Promise<{ id: string }> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST" });
    } catch (e) {
      throw new ThreadsApiError(
        `Threads request failed: ${(e as Error).message}`,
        "network"
      );
    }
    if (!res.ok) {
      throw new ThreadsApiError(`Threads API returned ${res.status}`, "api");
    }
    const json = (await res.json()) as { id?: unknown };
    if (typeof json.id !== "string") {
      throw new ThreadsApiError("Threads API response missing id", "api");
    }
    return { id: json.id };
  };

  return {
    async publish(text: string): Promise<{ id: string }> {
      const tok = encodeURIComponent(opts.token);
      const create = `${base}/${opts.userId}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&access_token=${tok}`;
      const { id: creationId } = await post(create);
      const publish = `${base}/${opts.userId}/threads_publish?creation_id=${encodeURIComponent(creationId)}&access_token=${tok}`;
      return post(publish);
    },
  };
}
