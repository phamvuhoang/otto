# Issue 29 Spec: Interactive Pause/Resume Controls

## Problem

Otto can currently stop a running loop only through process signals such as Ctrl-C. That aborts the active stage and exits, so a user must rerun the command to resume from `.otto/state.json`. A TTY run should expose lightweight keyboard controls so a user can pause safely after the current stage, resume in the same process, or gracefully quit.

## Approach

Add TTY-gated keyboard handling to `runLoop` itself, because the loop owns the stage boundaries, signal behavior, state persistence, and terminal cleanup. The controls should install only when stdin, stdout, and stderr are TTYs and the loop is not running under an external daemon signal. Use raw stdin for single-key commands:

- `p`: request a pause at the next stage boundary.
- `r`: resume when paused.
- `q`: gracefully quit with the same exit code and cleanup path as SIGINT.

Pausing must not abort the active stage. The pause gate runs between stages and before the next iteration/cooldown so work already produced by a stage is accounted and checkpointed before the loop blocks.

## Assumptions

- Question: Should pause happen between stages or only between iterations? Chosen answer: stage boundary. Rationale: the issue calls this more responsive, and `runLoop` already accounts and checkpoints after each stage.
- Question: Should `q` abort immediately or wait for a boundary? Chosen answer: immediate graceful quit, matching SIGINT. Rationale: the issue explicitly says `q` should be equivalent to today’s SIGINT semantics.
- Question: Should watch mode get its own poll pause? Chosen answer: not in this slice. Rationale: `runWatch` injects an external signal and owns daemon lifecycle; the issue’s hard acceptance criteria focus on loop runs and non-TTY/detached guards.
- Question: Should `p` interrupt an existing rate-limit sleep? Chosen answer: no. Rationale: pause requests are honored at loop safe boundaries; rate-limit sleep already has its own resume semantics and can still be interrupted by `q`/SIGINT.
- Question: How should detached runs be detected? Chosen answer: by TTY gating. Rationale: detached child stdio is redirected to a log, so stdin/stdout/stderr are not TTYs.
- Question: How much UI should be added? Chosen answer: one startup hint and terse pause/resume lines on stderr. Rationale: keeps output readable without adding an interactive UI layer.

## Testing Notes

Use `loop.test.ts` with mocked stage execution and fake TTY stdin/stdout/stderr properties. Pin the TTY hint, no-install behavior for non-TTY/external-signal runs, pause-at-boundary behavior, resume behavior, graceful `q`, and terminal raw-mode restoration.
