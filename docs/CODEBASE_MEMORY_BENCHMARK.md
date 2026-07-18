# Codebase Memory (P26) — benchmark & enable on a fresh machine

Otto's Codebase Memory adapter (P26) is **off by default**. Before enabling it,
prove on a real machine that graph-assisted retrieval actually lowers
exploration cost without hurting task success. This is the operator gate the
roadmap requires — enable it only if the numbers hold.

## 1. Prerequisites

- Node ≥ 20, pnpm ≥ 9, Otto built:
  ```bash
  git clone https://github.com/phamvuhoang/otto && cd otto
  pnpm install && pnpm -r build
  ```
- The pinned, checksum-verified **`codebase-memory` binary** (DeusData
  `codebase-memory-mcp`) on `PATH`. Otto never auto-installs it; provide it
  yourself and verify its checksum against the release you pinned:
  ```bash
  which codebase-memory && codebase-memory --version
  ```

## 2. Register the adapter (writes plain, inspectable `.otto/` config)

```bash
otto-extensions init codebase-intelligence     # writes .otto/tools/codebase-memory.json + config + policy
otto-tools health                              # must find the binary on PATH
```

This registers the tool **enabled but with `stages: []`** — it is inert until
you opt a stage in (step 4). Indexing writes are confined to `.otto/cbm-scratch`
(git-ignored); a write that escapes that dir aborts the index.

## 3. Run the A/B benchmark (gated — needs the real binary)

`benchmarks/configs.json` ships `cbm-off` (baseline) and `cbm-inject` (live
graph injection). Replay a suite under both and read the comparison:

```bash
OTTO_CBM_E2E=1 otto-eval benchmarks/suite.json benchmarks/configs.json --iterations 3
```

`OTTO_CBM_E2E=1` is what allows the real stdio child to run; without it the
codebase-memory paths stay skipped. The report prints a per-task table with the
P26 signals: **Tool calls**, **Tokens avoided**, **Impact recall**, **Indexing
overhead**. To A/B two already-recorded runs without re-paying:

```bash
otto-eval compare <cbm-off-run-id> <cbm-inject-run-id>   # or 'latest'
```

## 4. Decide, then enable (only if the numbers hold)

Enable per-stage **only** when `cbm-inject` shows, versus `cbm-off`:

- **lower** exploration input tokens and tool calls,
- at **equal-or-better** task success and **impact recall**,
- with index build/refresh overhead **repaid** by the retrieval savings.

If so, opt stages in via `.otto/config.json` (any enabled stage authorizes
indexing; include `plan` if you want the plan stage to use it):

```jsonc
{
  "tools": {
    "codebase-memory": {
      "enabled": true,
      "stages": ["plan", "implementer", "reviewer", "verifier"],
    },
  },
}
```

Re-run `otto-tools why plan` to confirm the tool is now active for the stage.
If the numbers **don't** hold, leave `stages: []` — the feature stays inert and
Otto behaves exactly as before.

## 5. Safety checks (any run)

- Confirm nothing escaped confinement: the run's `manifest.codebaseMemory`
  records the index identity and, on any escape, the escaped file list (the
  index is rejected and Otto falls back to normal search).
- A missing/unhealthy binary, a stale/wrong-project index, or an offline child
  all degrade to normal search with one recorded reason — never a broken run.

> Graph output is **navigation evidence, not the source of truth**: the agent
> still reads current source before editing, and tests remain the completion
> gate. Static graphs can be stale for dynamic dispatch and generated code.
