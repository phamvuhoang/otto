# issue-5 plan — Stabilize The Core Loop

Epic; one bite-sized task per iteration. Each task is test-first and ends green
on `pnpm -r typecheck && pnpm -r test && pnpm test`.

## Observability: `--print-config` preflight diagnostics

- [x] Add `preflight.ts`: pure `runPreflight({bin, workspaceDir}, probes)` +
      default `whichBin` PATH walker; unit-test both. Render the preflight block
      in `printConfig`. Export from `index.ts`.

## Later candidate tasks (not yet started)

- [ ] Harden unattended execution: audit wake-lock release + scratch cleanup on
      the interrupt path (SIGINT/SIGTERM) and add a regression test.
- [ ] Run summary: ensure end-of-run summary line reports cost total, iterations,
      and exit reason (sentinel / budget / error) consistently; test it.
- [ ] Docs: align README `--print-config` section + safety model with the
      supported `claude` runtime.
- [ ] Smoke: document + verify the pack-then-install local artifact test as the
      release smoke path.
