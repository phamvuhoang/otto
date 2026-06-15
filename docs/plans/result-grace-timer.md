# Plan: Post-result grace timer in `streamDocker`

> Source PRD: [phamvuhoang/otto#29](https://github.com/phamvuhoang/otto/issues/29) (mirror in `docs/prd/result-grace-timer.md`) — recover from claude CLI hangs that survive past the final `result` NDJSON event.
>
> **Target release**: `@phamvuhoang/otto-core` **0.6.1** (patch bump from 0.6.0). Driven by release-please from the `fix(core): …` commit that lands the implementation; no manual `package.json` / `.release-please-manifest.json` edits. CLI (`@phamvuhoang/otto`) is not bumped unless a sibling commit in the same release cycle touches the bins. Sandbox image (`packages/core/templates`) is unaffected.

## Architectural decisions

Durable decisions that apply across every phase:

- **Scope of change**: single function (`streamDocker`) in `packages/core/src/runner.ts`, plus one new pure helper colocated in the same file, plus a doc line in `README.md`. No new files. No changes to `runStage`, `runLoop`, `stages.ts`, or the bins.
- **Env var contract**: `OTTO_RESULT_GRACE_MS`. Default `30000`. `0` = disabled. Unset / empty / NaN / negative → default. Read directly from `process.env` inside the runner (matches `OTTO_IMAGE` / `OTTO_DOCKER_SOCK` pattern).
- **Trigger condition**: first NDJSON event with `type === "result"` arms a one-shot `setTimeout`. Subsequent `result` events do not re-arm.
- **Settlement contract**: on timer fire, kill the docker child (default signal, matches existing abort path) and **resolve** the stage promise with the `finalResult` already captured from the stream — do not reject. The loop driver must see a normal stage completion.
- **Settle-once guarantee**: timer is cleared inside the existing `finish()` guard on every terminal path (natural close, abort, error, grace-fire).
- **User-visible signal**: one dim stderr line via the existing `dim()` helper when the grace timer fires, naming the threshold.
- **Verification standard**: `pnpm -r typecheck` + manual smoke. No test suite is introduced (matches `CLAUDE.md` convention).
- **Pre-fix operator workaround (must remain valid on older versions)**: `docker ps --filter ancestor=docker.io/phamvuhoang/otto-sandbox:latest` + `docker kill <id>`. The container runs with `--rm`, so killing it removes it; otto rejects the current stage with `docker run exited with <code>` and aborts the iteration. Work already committed in earlier iterations is preserved. The 0.6.1 release notes must include this runbook so operators on `@phamvuhoang/otto-core` ≤ 0.6.0 still have a recovery path.

---

## Phase 1: Land the grace timer end-to-end

**User stories**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22 (all PRD stories).

### What to build

End-to-end behavior: when a stage's docker child emits a final `result` NDJSON event but fails to exit cleanly, otto waits up to `OTTO_RESULT_GRACE_MS` ms (default 30000), then kills the child and resolves the stage with the captured result text so the loop advances to the next stage. The behavior is opt-out via `OTTO_RESULT_GRACE_MS=0`. A single dim stderr line is emitted on kill explaining the threshold. The env var is documented alongside the other `OTTO_*` knobs in `README.md`.

### Acceptance criteria

- [ ] `pnpm -r typecheck` is clean from the repo root.
- [ ] In a healthy run (`otto-afk` against a tiny target workspace that completes a stage normally), the new grace timer never fires — no kill line on stderr, and the existing successful-completion code path is unchanged.
- [ ] In an induced-hang run (a stage whose child emits `result` then stays alive past the grace period — reproducible by either replaying the captured iter4 NDJSON against a `sleep infinity` stand-in or temporarily wrapping the template body in a long-running background process), otto emits exactly one dim stderr line naming the grace-period threshold, the container is killed, the stage promise resolves with the captured `finalResult` string, and the next stage starts.
- [ ] With `OTTO_RESULT_GRACE_MS=0` set, the induced-hang scenario reproduces the original behavior — otto waits indefinitely on `child.close` and the operator must `docker kill` manually.
- [ ] With `OTTO_RESULT_GRACE_MS=` set to a non-finite or negative value (e.g. `abc`, `-5`), behavior falls back to the 30000ms default (no crash, no NaN timer).
- [ ] Aborting a hung run via SIGINT (Ctrl+C) before the grace timer fires kills the child immediately via the existing abort path — the grace timer is cleared and does not fire afterwards.
- [ ] A natural docker close (the common case) clears the grace timer if it was armed — no spurious kill line on stderr after the stage completes.
- [ ] The stage promise settles exactly once in every code path (timer-fire, natural-close, abort, docker-error). No "promise already settled" warnings.
- [ ] `streamDocker`'s exported signature is unchanged. `runStage` and `runLoop` are untouched.
- [ ] `README.md` documents `OTTO_RESULT_GRACE_MS` in the same section as the other `OTTO_*` env vars, including the default and the `0` opt-out value.
- [ ] No new dependencies added to any `package.json`. No new files outside `docs/plans/` and the PRD scratch under `.otto-tmp/`.
- [ ] After the fix lands, the previously-required manual recovery (`docker ps --filter ancestor=docker.io/phamvuhoang/otto-sandbox:latest` + `docker kill <id>`) is no longer needed for the post-`result` self-deadlock scenario — otto self-recovers within the grace period.
- [ ] The 0.6.1 release notes (CHANGELOG entry generated by release-please from the `fix(core): …` commit) call out the manual `docker kill` runbook for operators still on `@phamvuhoang/otto-core` ≤ 0.6.0.
