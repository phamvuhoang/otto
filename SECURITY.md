# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories — open the repository's
**[Security → Report a vulnerability](https://github.com/phamvuhoang/otto/security/advisories/new)**
form — or email **phamvuhoang@gmail.com**. Include a description, reproduction steps, and the
affected version. You'll get an acknowledgement within a few days and a fix or mitigation plan.

## Supported versions

Only the latest published minor of each package (`@phamvuhoang/otto`, `@phamvuhoang/otto-core`) is
supported with security fixes. Pin by exact version if you need reproducibility.

## Threat model — read before running

Otto is an **autonomous agent harness**. By design it runs the Claude Code CLI with
`--permission-mode bypassPermissions` directly on the host, so the agent executes bash, edits,
and tool calls **without interactive approval**. Treat everything it ingests as instructions it
may act on. The trust boundary is:

- **Only run Otto against repositories, plans/PRDs, and GitHub issues you trust.** The plan/PRD
  string (`{{ INPUTS }}`), issue bodies/comments (`otto-ghafk`), and commit messages are all
  fed to a `bypassPermissions` agent. `otto-ghafk` in particular pulls **public GitHub issues**
  — text authored by strangers — into that agent. Do not point it at a repo whose open issues
  you have not vetted.

- **Blast radius depends on the runner.** The default `OTTO_RUNNER=sandbox` uses Claude Code's
  native OS sandbox (Seatbelt on macOS) to confine writes to the workspace tree, which is
  git-recoverable. `OTTO_RUNNER=host` runs unsandboxed — only safe in a throwaway tree.

- **Host credentials are accessible.** `claude` and `gh` on the host read `~/.claude`,
  `~/.claude.json`, and `~/.config/gh` directly. An agent running with `bypassPermissions`
  can read and overwrite those files. Use a scoped, short-lived `gh` token for untrusted inputs.

- **Per-runtime credentials and sandbox differ.** Otto is Claude-first by default, but the
  agent runtime is selectable (`--agent` / `OTTO_AGENT`; see [docs/CLI.md](./docs/CLI.md#agent-runtime---agent)).
  The default **Claude Code** runtime authenticates from `~/.claude` and is confined by the
  `--settings` native OS sandbox under `OTTO_RUNNER=sandbox` (below). The **Codex CLI** runtime
  authenticates from `~/.codex/auth.json` or the `OPENAI_API_KEY` environment variable, and does
  **not** use Claude's `--settings` sandbox — it has its own `--sandbox <mode> --ask-for-approval never`
  confinement, so the blast-radius controls are runtime-specific. Each runtime exposes only its
  own provider's credentials to the agent; review the active runtime with `--print-config` before
  a run. (The Codex execution adapter is not yet shipped — a real `--agent codex` run exits with a
  "not implemented yet" message — but its credential/sandbox surface is documented here so the
  threat model is complete when it lands.)

### Reducing blast radius

- Use the default `OTTO_RUNNER=sandbox` (native OS sandbox confines writes to the workspace).
- Run Otto on a disposable VM / dedicated machine, not your primary workstation, for untrusted
  inputs.
- Review open issues before running `otto-ghafk`.
- Use a scoped, short-lived `gh` token.

## Template authoring (contributors)

The prompt-template renderer (`render.ts`) executes the **command bodies** of the `` !`cmd` ``,
`` !?`cmd` ``, and `@spill` tags on the **host shell**. The shipped templates only ever use
**static** command strings, and `{{ INPUTS }}` is substituted last (written to a file the agent
reads, never re-shelled on the host) — so there is no host command-injection vector today.
**This invariant must be preserved:** never interpolate runtime or untrusted data into a tag
command body. Doing so would create direct host RCE.

The only runtime values a tag body may reference are the env vars `run-bin` validates to a
shell-safe charset before exporting — `$OTTO_ISSUE` (positive int / Linear ref) and
`$OTTO_GITHUB_REPO` (`owner/name`, via `parseGithubRepo`) — read from the process environment by
the shell, never spliced into the template text.
