# issue-12 — Prepare For Broader Adoption (plan)

Ordered, bite-sized, testable tasks decomposing issue #12. One task per AFK run.
See `.otto/specs/issue-12-design.md` for problem/approach/assumptions.

- [x] **Run-mode extension point + extension-points contract test.** Add a
      "## Adding a run mode" section to `CONTRIBUTING.md` (flag → gate-stage swap
      in `run-bin.ts`, preserving the gate/reviewer contract). Add
      `scripts/contributing-extension-points.test.mjs` pinning that the three
      extension points (stage / prompt / run mode) are documented, that the
      run-mode section states the gate sentinel + first-stage-is-gate invariant,
      and that every stage name it references is a real `STAGES` name parsed from
      `stages.ts`. Success signal: a contributor can add a stage/template/mode
      using docs alone, and the docs can't silently drift from the code.
- [x] **Release-readiness contract test.** Pin `RELEASING.md` against reality:
      the documented package contents (`files:` arrays) match each
      `package.json`, the rollback runbook + provenance (SBOM/cosign) sections are
      present, and the cut/publish flow names the real workflows. Catches release
      docs rotting when packaging changes.
- [x] **Security-doc contract test.** Pin `SECURITY.md`'s threat-model invariants:
      the `bypassPermissions` run line, the sandbox-vs-`OTTO_RUNNER=host` blast
      radius, and the static-shell-tag invariant — asserted against the real
      defaults in `runner.ts` / `render.ts` so a default change forces a doc edit.
- [x] **Beta-feedback capture template (non-code).** Add a structured feedback
      template (e.g. `.github/ISSUE_TEMPLATE/beta-feedback.md` or a
      `docs/BETA.md`) capturing setup friction, confusing docs, and unsafe
      defaults, with a rubric for ranking the resulting backlog. Process artifact;
      no runtime code. Success signal: beta feedback produces a ranked backlog.
