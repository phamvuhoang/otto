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

- **Host credentials are accessible.** `claude`, `codex`, and `gh` on the host read
  `~/.claude`, `~/.claude.json`, `~/.codex/auth.json`, and `~/.config/gh` directly.
  An agent running non-interactively can read and overwrite those files. Use a scoped,
  short-lived `gh` token for untrusted inputs.

- **Per-runtime credentials and sandbox differ.** Otto is Claude-first by default, but the
  agent runtime is selectable (`--agent` / `OTTO_AGENT`; see [docs/CLI.md](./docs/CLI.md#agent-runtime---agent)).
  The default **Claude Code** runtime authenticates from `~/.claude` and is confined by the
  `--settings` native OS sandbox under `OTTO_RUNNER=sandbox` (below). The **Codex CLI** runtime
  authenticates from `~/.codex/auth.json`, `CODEX_API_KEY`, or the compatibility
  `OPENAI_API_KEY` environment variable, and does **not** use Claude's `--settings` sandbox — it
  combines global `--ask-for-approval never` with its own `exec --ignore-user-config --sandbox
<mode>` confinement, so the blast-radius controls are runtime-specific. `--ignore-user-config`
  keeps personal Codex MCP/plugin config out of unattended stages while preserving Codex auth.
  Each runtime exposes only its own provider's credentials to the agent; review the active runtime
  with `--print-config` before a run.

- **P32 read-only PR-review stages run in a stricter sandbox than everything else.** The
  automated PR-review stages (`pr-review-lens`, `pr-review-verify`) exist specifically to analyze
  **untrusted contributor code** — an arbitrary PR head — so they never get the default
  `--permission-mode bypassPermissions` write access that every other stage uses. Instead they run
  `claude --permission-mode plan --tools Read,Glob,Grep --safe-mode --disable-slash-commands
--no-chrome --strict-mcp-config --mcp-config {}`: `plan` mode denies edits, the tool allowlist is
  read-only (`Read,Glob,Grep` — no `Bash`, no write/edit tools), the empty strict MCP config blocks
  any repo-declared MCP server, and safe mode disables hooks/plugins/custom agents and
  auto-loaded repo customizations. The child process also gets a credential-scrubbed environment
  (`GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, etc. stripped, plus a neutralized
  git/gh config) so a malicious PR head cannot exfiltrate or abuse the operator's push/pull
  credentials — see `buildReviewChildEnv` and `buildClaudeArgs` in
  `packages/core/src/runner.ts`. In short: `bypassPermissions` is the default for trusted,
  operator-directed work; `plan` is reserved for read-only review of untrusted input, and is
  strictly more restrictive.

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
