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
- **Claude Code** authenticated: `claude /login` once. This is the default runtime.
- **Codex CLI** authenticated when you select `--agent codex`: `codex login` once, or provide `CODEX_API_KEY` / `OPENAI_API_KEY` in the shell that launches Otto.
- **`gh`** authenticated (only required for `otto-ghafk`): `gh auth login` once.
- **Linear personal API key** (only required for `otto-linear-afk`): `otto-linear-auth login` once.

Docker is not required. Agent and provider CLIs on the host read their native credentials: `~/.claude`, `~/.claude.json`, `~/.codex/auth.json`, and `~/.config/gh`.

### Supported OS combinations

| Where you invoke `otto-afk` | Status | Notes                                                                           |
| --------------------------- | ------ | ------------------------------------------------------------------------------- |
| macOS native                | ✓      | Primary target. Native Seatbelt sandbox via `OTTO_RUNNER=sandbox` (default).    |
| Linux native (Ubuntu, etc.) | ✓      | Sandbox runner requires `bubblewrap`+`socat`; otherwise use `OTTO_RUNNER=host`. |

---

## First-run setup

Otto runs the selected agent CLI directly on the host. Credentials are read natively — no Docker mounts.

```bash
claude /login       # default runtime; writes ~/.claude + ~/.claude.json
codex login         # only needed when using --agent codex, unless using an API key
gh auth login       # only needed for otto-ghafk
```

For `gh auth login` pick: `GitHub.com` → `HTTPS` → `Y` (authenticate Git) → `Login with web browser`. Copy the one-time code, open `https://github.com/login/device` on the host browser, paste, approve.

Verify:

```bash
ls -la ~/.claude/.credentials.json ~/.claude.json
ls -la ~/.codex/auth.json
gh auth status
```

> **Same-shell rule:** run Otto from the same shell/user where you authenticated — credentials are read from the host home directory, not mounted or copied.

---

## Environment variables

| Variable                    | Default                           | Purpose                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTTO_WORKSPACE`            | `process.cwd()`                   | Host path the selected agent runs against (`cwd`). Also where `.otto-tmp/` is written.                                                                                                                                     |
| `OTTO_RUNNER`               | `sandbox`                         | `sandbox` (default) — confines writes to the workspace. Claude uses its native OS sandbox settings; Codex uses `--sandbox workspace-write`. `host` runs the selected agent unsandboxed.                                    |
| `OTTO_SANDBOX_NET`          | _(unset — unrestricted)_          | Comma-separated domain allowlist for sandbox network egress. Unset = unrestricted (filesystem confinement is the blast-radius control; network commands fall back to the bypass-approved escape hatch automatically).      |
| `OTTO_RESULT_GRACE_MS`      | `30000`                           | Milliseconds to wait after the final NDJSON result event before force-killing an agent child that fails to exit on its own. `0` disables the timer. Invalid values fall back to the default.                               |
| `OTTO_AGENT`                | `claude`                          | Agent CLI runtime: `claude` (default) or `codex`. Precedence: `--agent` flag → `OTTO_AGENT` → `.otto/config.json` `"agent"` → default `claude`. Invalid values are reported by `--print-config` and fatal on a real run.   |
| `OTTO_FALLBACK_AGENT`       | _(unset → no fallback)_           | Runtime to switch to when the active one hits a usage/rate limit: `claude` or `codex`. No default — unset means no fallback. Same as `--fallback-agent` / config `"fallbackAgent"`.                                        |
| `OTTO_AUTO_SWITCH_ON_LIMIT` | `off`                             | Switch to the fallback runtime on a limit when truthy (`1`/`true`/`yes`/`on`). Same as `--auto-switch-on-limit` / config `"autoSwitchOnLimit"`. Off by default — switching providers must be explicit.                     |
| `OTTO_MODEL`                | _(unset → CLI default)_           | Pins the model for the **active** runtime. When non-empty, `--model <value>` is passed through to the agent CLI for every stage. Empty/whitespace = unset. Pass-through: the CLI owns validation.                          |
| `OTTO_CLAUDE_MODEL`         | _(unset → falls to `OTTO_MODEL`)_ | Claude-specific model override; wins over `OTTO_MODEL` when the active runtime is `claude`. Empty/whitespace falls through to `OTTO_MODEL`.                                                                                |
| `OTTO_CODEX_MODEL`          | _(unset → falls to `OTTO_MODEL`)_ | Codex-specific model override; wins over `OTTO_MODEL` when the active runtime is `codex`. Empty/whitespace falls through to `OTTO_MODEL`.                                                                                  |
| `CODEX_API_KEY`             | _(unset)_                         | Optional Codex API key for `codex exec`; use only in the shell/process that launches a trusted Otto run. `codex login` is preferred for normal local use.                                                                  |
| `OPENAI_API_KEY`            | _(unset)_                         | Compatibility Codex API-key source. When `CODEX_API_KEY` is unset, Otto maps this to `CODEX_API_KEY` for the spawned Codex process.                                                                                        |
| `OTTO_TOKEN_MODE`           | `off`                             | Token accounting mode: `off` preserves current output, `measure` prints per-stage/run token usage, `reduce` also applies conservative render-time prompt compaction. Overridden by `--token-mode`.                         |
| `OTTO_REVIEW_LENSES`        | `correctness,security,tests`      | Comma-separated lens list for the reviewer panel. Setting it implies `--review-panel`.                                                                                                                                     |
| `OTTO_MAX_WAIT`             | `6h`                              | Maximum time to wait out an agent rate-limit before halting cleanly and saving resume state. Accepts seconds (`90`) or a duration string (`90m`, `6h`). Equivalent to `--max-wait`.                                        |
| `OTTO_WATCH_LABEL`          | `otto`                            | Issue label that gates a `--watch` run (`otto-ghafk`).                                                                                                                                                                     |
| `OTTO_LINEAR_API_KEY`       | _(unset)_                         | Linear personal API key for `otto-linear-afk`. Highest-precedence source, then `LINEAR_API_KEY`, then `~/.config/otto/linear.json` (written by `otto-linear-auth login`).                                                  |
| `LINEAR_API_KEY`            | _(unset)_                         | Fallback Linear API key source (precedence below `OTTO_LINEAR_API_KEY`).                                                                                                                                                   |
| `OTTO_LINEAR_LABEL`         | `otto`                            | Label gating Linear issue selection and `--watch` polling (`otto-linear-afk`).                                                                                                                                             |
| `OTTO_LINEAR_TEAM`          | _(unset)_                         | Optional Linear team-key narrowing for selection/polling (e.g. `ENG`).                                                                                                                                                     |
| `OTTO_LINEAR_DONE_STATE`    | _(unset)_                         | Name of the workflow state `otto-linear done` moves an issue to; else the first `type = completed` state.                                                                                                                  |
| `OTTO_BRANCH`               | _(unset → `current`)_             | Branch isolation strategy: `current`, `branch`, or `worktree`. Overrides `.otto/config.json`; overridden by `--branch`.                                                                                                    |
| `OTTO_BRANCH_PREFIX`        | `otto/`                           | Raw prefix concatenated to the generated branch/worktree name. Overrides `.otto/config.json`; overridden by `--branch-prefix`. Superseded by `OTTO_BRANCH_CONVENTION` when both are set.                                   |
| `OTTO_BRANCH_CONVENTION`    | `otto`                            | Validated, slash-normalized branch namespace (`<convention>/<task-key>`). Canonical replacement for `OTTO_BRANCH_PREFIX`. `feat` and `feat/` both yield `feat/`; unsafe values abort. Overridden by `--branch-convention`. |
| `NO_COLOR` / `TERM=dumb`    | _(unset)_                         | Disable ANSI color in Otto's own output. Color is also auto-disabled when stdout/stderr is not a TTY, so piping to a file stays clean.                                                                                     |

Run `otto-afk --print-config` to see how all of the above resolve for your current shell and workspace, without launching a loop. It prints two blocks: the **resolved config**, then a **preflight** check of the run's prerequisites — the selected agent CLI/auth, a git workspace to commit into, and provider-specific CLIs such as `gh`. Each line is marked `✓`/`✗` with a remediation hint, so you can fix setup before any paid invocation:

```text
[otto-afk] preflight
  ✓ claude CLI          /usr/local/bin/claude
  ✓ claude auth         credentials found
  ✓ workspace git repo  /path/to/your/repo
```

`otto-ghafk` adds `gh CLI` and `gh auth` rows; `otto-linear-afk` adds a `linear auth` row (resolved credential source, or `run otto-linear-auth login` when absent). Preflight reports only — it never exits non-zero or blocks the run.

Preflight is **runtime-aware**: it shows the rows for the **selected** runtime, not both. A `--agent codex` run shows `codex CLI` + `codex auth` rows instead of Claude's — and the `codex CLI` row probes that `codex --version` actually succeeds (not just that `codex` is on `PATH`), because the `@openai/codex` npm shim can sit on `PATH` while its native binary is missing or broken. Codex credentials resolve from `~/.codex/auth.json`, `CODEX_API_KEY`, or `OPENAI_API_KEY`.

---

## Runner & sandbox

`OTTO_RUNNER` selects how the active runtime is spawned:

- **`sandbox` (default)** — Filesystem **writes are confined to the workspace**. Claude receives a transient `--settings` JSON that enables its native OS sandbox (Seatbelt on macOS; `bubblewrap`+`socat` on Linux). Codex receives `--sandbox workspace-write --ask-for-approval never`. `OTTO_SANDBOX_NET` applies to Claude's native sandbox settings; Codex owns its own network behavior.
- **`host`** — The active runtime runs unsandboxed with full host access. Claude omits the sandbox settings file; Codex receives `--sandbox danger-full-access`. Only safe when the workspace is a git-recoverable, throwaway tree.

Claude stages run with `--permission-mode bypassPermissions`; Codex stages run with `--ask-for-approval never`. AFK is non-interactive, so bash/edit approval must be automatic. The sandbox runner and the git-recoverable workspace are what bound the blast radius. See **[SECURITY.md](../SECURITY.md)** for the full threat model.

---

## Branch strategy

Where Otto commits is resolved **once at startup**, in this order: `--branch`/`OTTO_BRANCH` flag/env → `.otto/config.json` (`branchStrategy`/`branchPrefix` keys) → interactive TTY prompt (offers "Remember for this repo?" which writes `.otto/config.json`) → default `current`. Detached and non-TTY runs never prompt; they fall back through flag/env/config to `current`.

| Strategy   | Behavior                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`  | Commits land on whatever branch is checked out (default).                                                                                                                                    |
| `branch`   | Otto creates and switches to `<prefix><slug>` before the loop starts (slug = basename of the plan file for `otto-afk`; a timestamp for `otto-ghafk`; `-2`/`-3` suffix on name collision).    |
| `worktree` | Otto creates an isolated git worktree at `<workspace>/.otto-tmp/worktrees/<slug>`; the entire run happens there. **Not** removed automatically — run `git worktree remove <path>` when done. |

`--branch-convention <c>` (default `otto`) sets the validated branch namespace `<c>/<task-key>` — it normalizes an optional trailing slash (`feat` and `feat/` both produce `feat/`) and rejects git-ref-unsafe values. It is the canonical replacement for the older raw `--branch-prefix <p>` (kept for back-compat, concatenated verbatim with no validation). Precedence: `--branch-convention` → `--branch-prefix` → config `branchConvention` → config `branchPrefix` → `otto/`. `--print-config` shows the resolved namespace.

Otto warns at startup if the working tree has uncommitted tracked changes under `current` or `branch` mode, because dirty trees disable the review panel's read-only enforcement.

Per-task artifacts (spec, plan, follow-ups) are grouped under `.otto/tasks/<task-key>/`, named with the same task key as the branch. See **[MIGRATION.md](./MIGRATION.md)** for the old→new path mapping and how to migrate an existing repo.
