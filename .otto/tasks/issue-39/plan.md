# Plan — issue #39: Run trajectory and evidence bundle (P0)

Ordered, bite-sized, testable tasks. One iteration implements one task.

- [x] **1. Data substrate (`run-report.ts`).** Define `RunManifest`,
      `StageRecord`, `RunArtifact` types; `allocateRunId(date?, pid?)`; path
      helpers (`runsDir` / `runReportDir`); read+write for the manifest and
      stage records (`writeManifest` / `readManifest` / `writeStageRecord` /
      `readStageRecords`). Export from `index.ts`. Inert — no loop wiring yet.
      Verify: new `run-report.test.ts` green + typecheck.
- [x] **2. Allocate a run-id at loop start + write an initial manifest.**
      `runLoop` allocates a `runId`, writes `.otto/runs/<run-id>/manifest.json`
      with bin, mode, inputs, runtime, branch strategy, planned iterations, and
      `startedAt`. Thread a `branchStrategy` into `LoopOptions` from run-bin.
      Add `.otto/runs/` to the workspace `.gitignore` (mirror state.json).
      Verify: `loop.test.ts` asserts a manifest exists after a one-iteration run.
- [x] **3. Write one stage record after each stage.** In the loop's per-stage
      path (and inside `runPanel` substages), normalize the `StageResult` into a
      `StageRecord` and `writeStageRecord`. Verify: `loop.test.ts` asserts N
      stage records for N stages; panel substages recorded.
- [x] **4. Finalize the manifest on every terminal path.** On loop exit, update
      the manifest with `completedIterations`, cost/token totals, `exitReason`,
      `nextAction`, `finishedAt`, and artifact links (NDJSON logs dir, plus the
      review-followups trail when present). Funnelled through the existing
      `summarize` so every exit reason is covered. Verify: `loop.test.ts`
      asserts the finalized fields per exit path. **Interrupt paths
      (SIGINT/SIGTERM/keyboard quit via `process.exit`) leave only the initial
      manifest — finalizing those is deferred (out of the summarize funnel).**
- [x] **5. Render a human summary (`otto-inspect <run-id>` / `latest`, or
      `--run-report`).** Read the manifest + stage records and print a compact
      report answering "what happened and why did Otto stop?". Verify: a unit
      test over a fixture bundle; a one-iteration integration smoke.
      Shipped as a new `otto-inspect` bin → `runInspect` in `inspect.ts`
      (pure `formatRunReport` + `listRunIds`). Verified by `inspect.test.ts`
      and a manual bin smoke.
- [x] **6. Docs.** README + `docs/ARCHITECTURE.md`: the bundle layout, run-id
      format, and the inspect command. Shipped as prose (no doc-contract test —
      a stable layout + command is low drift risk): README gains a "Why Otto"
      bullet, an `otto-inspect latest` example, and the bin in "How it works";
      ARCHITECTURE gains a `## Run evidence bundle` section plus `run-report.ts`
      / `inspect.ts` module-map + index re-export entries.

All tasks complete. Next: **NO MORE TASKS** (docs landed; otto-inspect smoke
verified `Usage: otto-inspect [<run-id>|latest]`).
