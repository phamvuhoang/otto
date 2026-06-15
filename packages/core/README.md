# @phamvuhoang/otto-core

Library half of **[Otto](https://github.com/phamvuhoang/otto)** — a harness that drives the
[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) CLI against a target
repository in an iterating implementer → reviewer loop, running directly on the host OS.

This package is the engine: the iteration loop driver, the runner + NDJSON stream
renderer, the prompt-template renderer, and the stage registry. The user-facing CLI lives in
**[`@phamvuhoang/otto`](https://www.npmjs.com/package/@phamvuhoang/otto)** (`otto-afk` / `otto-ghafk`).

> **Security:** Otto runs Claude with `--permission-mode bypassPermissions`. Point it
> only at repositories and prompts you trust. See the repo's
> [SECURITY.md](https://github.com/phamvuhoang/otto/blob/main/SECURITY.md).

## Install

```bash
npm i @phamvuhoang/otto-core
```

## Use

```ts
import {
  runAfk,
  runGhAfk,
  runLoop,
  STAGES,
  renderTemplate,
} from "@phamvuhoang/otto-core";

// Drive the plan/PRD loop from argv (same entry the otto-afk bin uses):
await runAfk(["<plan-and-prd>", "5"]);
```

Public surface: `runAfk`, `runGhAfk`, `runLoop`, `STAGES`, `Stage`, `renderTemplate`,
`runStage`. Subpath exports: `./loop`, `./runner`, `./stages`.

`runStage` spawns `claude` directly on the host with `cwd` set to the workspace directory.
By default (`OTTO_RUNNER=sandbox`) it writes a transient `--settings` JSON that enables
the native OS sandbox, confining writes to the workspace. Set `OTTO_RUNNER=host` to run
unsandboxed. Credentials (`~/.claude`, `~/.config/gh`) are read natively — no bind-mounts
required. The `templates/` directory (prompt playbooks) ships in the tarball.

## Docs

Full usage, setup, environment variables, and architecture are in the
**[main README](https://github.com/phamvuhoang/otto#readme)** and
**[docs/ARCHITECTURE.md](https://github.com/phamvuhoang/otto/blob/main/docs/ARCHITECTURE.md)**.

## License

[MIT](https://github.com/phamvuhoang/otto/blob/main/LICENSE) © Henry Pham.
