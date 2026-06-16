import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import {
  createLinearClient,
  linearConfigPath,
  resolveLinearAuth,
  LinearApiError,
  type LinearViewer,
} from "./linear-api.js";

/**
 * Injectable host surface for {@link runLinearAuth} so the credential tool stays
 * pure-ish and unit-testable without touching the real home dir, stdin, or the
 * network. {@link defaultLinearAuthDeps} wires up the host.
 */
export type LinearAuthCliDeps = {
  env: NodeJS.ProcessEnv;
  /** Home directory holding the credential file. */
  home: string;
  /** Read a file's contents, or null if it is absent/unreadable. */
  readFile: (path: string) => string | null;
  /** Write `contents` to `path`, creating parent dirs, with the given mode. */
  writeFile: (path: string, contents: string, mode: number) => void;
  /** Delete `path`; return true if a file was actually removed. */
  removeFile: (path: string) => boolean;
  /** Read the API key the user pastes on stdin (login). */
  readStdin: () => Promise<string>;
  /** Print one line to stdout. */
  out: (msg: string) => void;
  /** Print one line to stderr. */
  err: (msg: string) => void;
  /** Live credential check for `status --verify-live`; injectable for tests. */
  verify: (token: string) => Promise<LinearViewer>;
};

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Host-wired defaults for {@link runLinearAuth}. */
export const defaultLinearAuthDeps: LinearAuthCliDeps = {
  env: process.env,
  home: homedir(),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, contents, mode) => {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, contents, { mode });
    // `mode` above only applies when the file is created, so re-tighten an
    // existing credential file whose perms may have drifted looser.
    chmodSync(p, mode);
  },
  removeFile: (p) => {
    try {
      unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  },
  readStdin: readAllStdin,
  out: (m) => process.stdout.write(`${m}\n`),
  err: (m) => process.stderr.write(`${m}\n`),
  verify: (token) => createLinearClient({ token }).whoami(),
};

const USAGE =
  "Usage: otto-linear-auth <login|status [--verify-live]|logout>";

/**
 * Drive the `otto-linear-auth` credential tool. Resolves to the process exit
 * code so the thin bin wrapper can `process.exit(code)`.
 *
 * - `login`  — read a Linear personal API key from stdin and store it at
 *   `~/.config/otto/linear.json` (`0600`, outside any repo). The secret is
 *   never echoed back.
 * - `status` — report whether a credential resolves (and from where, via
 *   {@link resolveLinearAuth}) without printing the token; `--verify-live`
 *   additionally calls the Linear API to confirm the key works.
 * - `logout` — delete the stored credential file; warns if an env-var key
 *   still takes precedence.
 */
export async function runLinearAuth(
  argv: string[],
  deps: LinearAuthCliDeps = defaultLinearAuthDeps
): Promise<number> {
  const [sub, ...rest] = argv;
  const path = linearConfigPath(deps.home);

  switch (sub) {
    case "login": {
      const token = (await deps.readStdin()).trim();
      if (!token) {
        deps.err("No API key provided. Paste your Linear personal API key.");
        return 1;
      }
      const body = JSON.stringify({ type: "apiKey", token }, null, 2);
      deps.writeFile(path, `${body}\n`, 0o600);
      deps.out(`Stored Linear API key at ${path} (0600).`);
      return 0;
    }

    case "status": {
      const auth = resolveLinearAuth({
        env: deps.env,
        readFile: deps.readFile,
        home: deps.home,
      });
      if (!auth) {
        deps.out("Linear auth: not found — run `otto-linear-auth login`.");
        return 1;
      }
      deps.out(`Linear auth: found (source: ${auth.source}).`);

      if (rest.includes("--verify-live")) {
        try {
          const me = await deps.verify(auth.token);
          deps.out(`Verified live as ${me.name} <${me.email}>.`);
        } catch (e) {
          const kind = e instanceof LinearApiError ? ` (${e.kind})` : "";
          deps.err(`Live verification failed${kind}: ${(e as Error).message}`);
          return 1;
        }
      }
      return 0;
    }

    case "logout": {
      const removed = deps.removeFile(path);
      deps.out(
        removed
          ? `Removed stored Linear credential at ${path}.`
          : `No stored credential at ${path}; nothing to remove.`
      );
      for (const name of ["OTTO_LINEAR_API_KEY", "LINEAR_API_KEY"] as const) {
        if (deps.env[name]?.trim()) {
          deps.out(
            `Note: ${name} is still set and takes precedence over the file.`
          );
        }
      }
      return 0;
    }

    default:
      deps.err(USAGE);
      return 2;
  }
}
