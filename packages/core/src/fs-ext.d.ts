/**
 * Minimal ambient types for the native `fs-ext` addon. Only the `flock` surface
 * the review lease uses is declared. `flockSync` takes an open fd and an
 * operation string; `exnb` is exclusive non-blocking and throws an `EAGAIN`/
 * `EWOULDBLOCK` errno error when another open file description already holds the
 * lock. `un` releases. The kernel auto-releases the lock when the fd closes or
 * the holding process dies, which is what makes crash recovery automatic.
 */
declare module "fs-ext" {
  export type FlockOp = "sh" | "ex" | "shnb" | "exnb" | "un";
  export function flockSync(fd: number, op: FlockOp): void;
  export function flock(
    fd: number,
    op: FlockOp,
    callback: (err: NodeJS.ErrnoException | null) => void
  ): void;
}
