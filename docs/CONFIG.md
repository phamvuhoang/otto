# Configuration

Environment variables, runner/sandbox behavior, branch strategy, prerequisites, and first-run setup for Otto. For flags and per-command usage see **[CLI.md](./CLI.md)**.

- [Prerequisites](#prerequisites)
- [First-run setup](#first-run-setup)
- [Environment variables](#environment-variables)
- [Runner & sandbox](#runner--sandbox)
- [Branch strategy](#branch-strategy)

---

## Prerequisites

- **Node.js 20+** + **npm 9+** (or `pnpm`/`yarn`). For macOS/Linux: nvm, asdf, or distro package.
- **Claude Code** authenticated: `claude /login` once. macOS is the primary supported target (Seatbelt sandbox). Linux works with the default sandbox runner if `bubblewrap` + `socat` are installed; otherwise use `OTTO_RUNNER=host`.
- **`gh`** authenticated (only required for `otto-ghafk`): `gh auth login` once.

Docker is not required. `claude` and `gh` on the host read `~/.claude`, `~/.claude.json`, and `~/.config/gh` natively.

### Supported OS combinations

| Where you invoke `otto-afk` | Status | Notes                                                                          |
| --------------------------- | ------ | ------------------------------------------------------------------------------ |
| macOS native                | ✓      | Primary target. Native Seatbelt sandbox via `OTTO_RUNNER=sandbox` (default).   |
| Linux native (Ubuntu, etc.) | ✓      | Sandbox runner requires `bubblewrap`+`socat`; otherwise use `OTTO_RUNNER=host`. |

---

## First-run setup

Otto runs `claude` directly on the host. Credentials are read natively — no Docker mounts.

```bash
claude /login       # browser flow; writes ~/.claude + ~/.claude.json
gh auth login       # only needed for otto-ghafk
```

For `gh auth login` pick: `GitHub.com` → `HTTPS` → `Y` (authenticate Git) → `Login with web browser`. Copy the one-time code, open `https://github.com/login/device` on the host browser, paste, approve.

Verify:

```bash
ls -la ~/.claude/.credentials.json ~/.claude.json
gh auth status
```

> **Same-shell rule:** run Otto from the same shell/user where you authenticated — credentials are read from the host home directory, not mounted or copied.

---

## Environment variables

| Variable                 | Default                      | Purpose                                                                                                                                                                                                               |
| ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTTO_WORKSPACE`         | `process.cwd()`              | Host path Claude runs against (`cwd`). Also where `.otto-tmp/` is written.                                                                                                                                             |
| `OTTO_RUNNER`            | `sandbox`                    | `sandbox` (default) — enables the native OS sandbox (Seatbelt on macOS), confining writes to the workspace. `host` — runs claude unsandboxed (only safe in a git-recoverable, throwaway tree).                         |
| `OTTO_SANDBOX_NET`       | _(unset — unrestricted)_     | Comma-separated domain allowlist for sandbox network egress. Unset = unrestricted (filesystem confinement is the blast-radius control; network commands fall back to the bypass-approved escape hatch automatically). |
| `OTTO_RESULT_GRACE_MS`   | `30000`                      | Milliseconds to wait after the final NDJSON `result` event before force-killing a `claude` child that fails to exit on its own. `0` disables the timer. Invalid values fall back to the default.                       |
| `OTTO_MODEL`             | _(unset → CLI default)_      | Pins the Claude model. When non-empty, `--model <value>` is passed through to the `claude` CLI for every stage. Empty/whitespace = unset. Pass-through: the `claude` CLI owns validation.                              |
| `OTTO_REVIEW_LENSES`     | `correctness,security,tests` | Comma-separated lens list for the reviewer panel. Setting it implies `--review-panel`.                                                                                                                                 |
| `OTTO_MAX_WAIT`          | `6h`                         | Maximum time to wait out a Claude rate-limit before halting cleanly and saving resume state. Accepts seconds (`90`) or a duration string (`90m`, `6h`). Equivalent to `--max-wait`.                                    |
| `OTTO_WATCH_LABEL`       | `otto`                       | Issue label that gates a `--watch` run (`otto-ghafk`).                                                                                                                                                                 |
| `OTTO_BRANCH`            | _(unset → `current`)_        | Branch isolation strategy: `current`, `branch`, or `worktree`. Overrides `.otto/config.json`; overridden by `--branch`.                                                                                                |
| `OTTO_BRANCH_PREFIX`     | `otto/`                      | Prefix for the generated branch/worktree name. Overrides `.otto/config.json`; overridden by `--branch-prefix`.                                                                                                         |
| `NO_COLOR` / `TERM=dumb` | _(unset)_                    | Disable ANSI color in Otto's own output. Color is also auto-disabled when stdout/stderr is not a TTY, so piping to a file stays clean.                                                                                  |

Run `otto-afk --print-config` to see how all of the above resolve for your current shell and workspace, without launching a loop. It prints two blocks: the **resolved config**, then a **preflight** check of the run's prerequisites — the `claude` CLI and its credentials, a git workspace to commit into, and (for `otto-ghafk`) the `gh` CLI and its credentials. Each line is marked `✓`/`✗` with a remediation hint, so you can fix setup before any paid `claude` invocation:

```text
[otto-afk] preflight
  ✓ claude CLI          /usr/local/bin/claude
  ✓ claude auth         credentials found
  ✓ workspace git repo  /path/to/your/repo
```

`otto-ghafk` adds `gh CLI` and `gh auth` rows. Preflight reports only — it never exits non-zero or blocks the run.

---

## Runner & sandbox

`OTTO_RUNNER` selects how `claude` is spawned:

- **`sandbox` (default)** — Otto writes a transient `--settings` JSON that enables Claude Code's native OS sandbox (Seatbelt on macOS; `bubblewrap`+`socat` on Linux). Filesystem **writes are confined to the workspace** — that is the blast-radius control. `OTTO_SANDBOX_NET` optionally restricts network egress to an allowlist.
- **`host`** — claude runs unsandboxed with full host access. Only safe when the workspace is a git-recoverable, throwaway tree.

Every stage runs with `--permission-mode bypassPermissions` (AFK is non-interactive, so bash/edit approval must be automatic). The sandbox runner and the git-recoverable workspace are what bound the blast radius. See **[SECURITY.md](../SECURITY.md)** for the full threat model.

---

## Branch strategy

Where Otto commits is resolved **once at startup**, in this order: `--branch`/`OTTO_BRANCH` flag/env → `.otto/config.json` (`branchStrategy`/`branchPrefix` keys) → interactive TTY prompt (offers "Remember for this repo?" which writes `.otto/config.json`) → default `current`. Detached and non-TTY runs never prompt; they fall back through flag/env/config to `current`.

| Strategy   | Behavior                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`  | Commits land on whatever branch is checked out (default).                                                                                                              |
| `branch`   | Otto creates and switches to `<prefix><slug>` before the loop starts (slug = basename of the plan file for `otto-afk`; a timestamp for `otto-ghafk`; `-2`/`-3` suffix on name collision). |
| `worktree` | Otto creates an isolated git worktree at `<workspace>/.otto-tmp/worktrees/<slug>`; the entire run happens there. **Not** removed automatically — run `git worktree remove <path>` when done. |

`--branch-prefix <p>` (default `otto/`) sets the generated branch name prefix.

Otto warns at startup if the working tree has uncommitted tracked changes under `current` or `branch` mode, because dirty trees disable the review panel's read-only enforcement.
