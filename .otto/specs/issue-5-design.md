# issue-5 — Stabilize The Core Loop

GitHub issue #5 is a month-long **epic** (the ROADMAP "Month 1" theme), not a
single task. It bundles four initiatives: loop observability, hardened
unattended execution, public positioning, and smoke coverage. There is no human
in the loop, so this design picks the **single most concrete, highest-leverage
success signal** and implements one bite-sized task against it per iteration.

## Problem

Success signal #1 is the most concrete and testable:

> `otto-afk --print-config` gives enough context to debug setup before a paid run.

Today `printConfig` (`packages/core/src/cli-help.ts`) prints the *resolved
configuration* (workspace, runner, model, budget, etc.) but performs **no
preflight diagnostics**. A new user cannot tell from its output whether the run
will even start:

- `claude` is spawned as a bare `claude` from `PATH` (`runner.ts`). If it is not
  installed/on `PATH`, every iteration fails — but `--print-config` is silent.
- Otto commits into the workspace, so the workspace must be a git repo.
- `claude` / `gh` read credentials from the home dir (`~/.claude.json`,
  `~/.config/gh`). Missing creds → auth failure mid-run, after spend.
- `otto-ghafk` additionally needs the `gh` CLI on `PATH`.

So a user can pass `--print-config`, see a clean config block, start a paid run,
and *then* hit a setup failure. That defeats the stated purpose of the flag.

## Approach

Add a **preflight diagnostics block** to `--print-config` output that checks each
prerequisite and reports `ok` / `MISSING` with a one-line remediation hint.

Make the check logic a **pure, dependency-injected function** so it is unit
testable without real binaries or a real home dir:

```ts
// preflight.ts
export type PreflightResult = { label: string; ok: boolean; detail: string };
export type PreflightProbes = {
  resolveBin: (name: string) => string | null; // null = not on PATH
  pathExists: (p: string) => boolean;
  home: string;
};
export function runPreflight(
  opts: { bin: string; workspaceDir: string },
  probes: PreflightProbes
): PreflightResult[];
```

Checks (gh-specific ones only when `bin === "otto-ghafk"`):

1. **claude CLI** — `resolveBin("claude")` → path or "not found on PATH — install Claude Code".
2. **claude auth** — `~/.claude.json` or `~/.claude` exists → else "run `claude /login`".
3. **workspace git repo** — `<workspaceDir>/.git` exists → else "not a git repo — Otto commits here".
4. **gh CLI** (ghafk only) — `resolveBin("gh")` → else "not found on PATH — install GitHub CLI".
5. **gh auth** (ghafk only) — `~/.config/gh` exists → else "run `gh auth login`".

Default probes: a small `whichBin` PATH walker (honours `PATHEXT` on Windows,
matching `render.ts`'s cross-platform care) + `fs.existsSync` + `os.homedir()`.

`printConfig` calls `runPreflight` with the default probes and appends a
`preflight` block, one line per check (`✓`/`✗`). This is the only behavioral
change; the existing resolved-config block is untouched.

## Assumptions

- **Q: Which success signal to tackle first?** → `--print-config` preflight.
  *Rationale:* most concrete, fully unit-testable, no paid runs needed, directly
  named in the issue, and high leverage (prevents wasted spend on misconfigured runs).
- **Q: New module or inline in cli-help.ts?** → new `preflight.ts`.
  *Rationale:* cli-help.ts is already ~443 lines; a focused pure module is the
  testable unit. Keeps printConfig a thin renderer.
- **Q: Run real shell-outs in checks?** → no; probes are injected.
  *Rationale:* deterministic tests; printConfig must never spawn `claude`.
- **Q: Fail/exit on a failed check?** → no, report only.
  *Rationale:* `--print-config` is a read-only diagnostic; it already early-returns.
  Exit-code semantics would be a larger, separate change.
- **Q: gh checks always?** → only for `otto-ghafk`.
  *Rationale:* `otto-afk` never invokes `gh`; showing gh as "missing" would be noise.

## Testing notes

- Unit-test `runPreflight` with stub probes: all-present → all `ok`; each missing
  prerequisite flips exactly one result and yields the right hint; gh checks
  present only for `otto-ghafk`.
- Unit-test the default `whichBin` PATH walker against a temp dir with a fake
  executable on a synthetic `PATH`.
- Existing `pnpm -r typecheck && pnpm -r test && pnpm test` stays green.
