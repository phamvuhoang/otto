# @phamvuhoang/otto

CLI for **[Otto](https://github.com/phamvuhoang/otto)** — a harness that drives the
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) CLI against a target
repository in an iterating implementer → reviewer loop, running `claude` directly on the host.
Docker is not required.

Exposes two bin entries (thin wrappers over
**[`@phamvuhoang/otto-core`](https://www.npmjs.com/package/@phamvuhoang/otto-core)**):

- **`otto-afk`** — plan/PRD-driven loop. Iterates until the agent emits `<promise>NO MORE TASKS</promise>`.
- **`otto-ghafk`** — GitHub-issue-driven loop. Pulls open issues and lets the agent pick the next task.

> **Security:** Otto runs Claude with `--permission-mode bypassPermissions`. The default
> `OTTO_RUNNER=sandbox` uses Claude Code's native OS sandbox (Seatbelt on macOS) to confine
> writes to the workspace. Point it only at repositories and prompts you trust. See
> [SECURITY.md](https://github.com/phamvuhoang/otto/blob/main/SECURITY.md).

## Install

```bash
npm i -g @phamvuhoang/otto
```

## Use

```bash
cd /path/to/your/workspace
otto-afk "<plan-and-prd>" 5      # plan/PRD loop
otto-ghafk 5                     # GitHub-issue loop
otto-afk --help                  # flags, env vars
otto-afk --print-config          # diagnose workspace / runner / sandbox config
```

Requires an authenticated Claude Code login (and `gh` for `otto-ghafk`). First-run
setup, per-OS notes, and the full flag/env reference are in the
**[main README](https://github.com/phamvuhoang/otto#readme)** and
**[QUICKSTART](https://github.com/phamvuhoang/otto/blob/main/QUICKSTART.md)**.

## License

[MIT](https://github.com/phamvuhoang/otto/blob/main/LICENSE) © Henry Pham.
