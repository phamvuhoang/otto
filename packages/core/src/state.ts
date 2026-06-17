import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentRuntimeId } from "./agent-runtime.js";

export type RunStatus =
  | "running"
  | "waiting-rate-limit"
  | "interrupted"
  | "complete";

export type RunState = {
  bin: string;
  mode: string;
  inputs: string;
  iteration: number;
  of: number;
  status: RunStatus;
  resetsAt?: number | null;
  /** Active runtime at persist time. Records an auto-switch so a resumed run
   *  keeps the fallback (unless --fresh clears state). Absent on pre-switch runs. */
  agent?: AgentRuntimeId;
  startedAt: string;
  updatedAt: string;
};

const STATE_REL = join(".otto", "state.json");

/** Read .otto/state.json. Absent or malformed → null (never throws). */
export function readState(workspaceDir: string): RunState | null {
  try {
    return JSON.parse(
      readFileSync(join(workspaceDir, STATE_REL), "utf8")
    ) as RunState;
  } catch {
    return null;
  }
}

/** Write .otto/state.json (creates .otto/). */
export function writeState(workspaceDir: string, s: RunState): void {
  mkdirSync(join(workspaceDir, ".otto"), { recursive: true });
  writeFileSync(
    join(workspaceDir, STATE_REL),
    JSON.stringify(s, null, 2) + "\n"
  );
}

/** Remove .otto/state.json; ignore if absent. */
export function clearState(workspaceDir: string): void {
  rmSync(join(workspaceDir, STATE_REL), { force: true });
}

/** Resume iff a prior unfinished run matches this invocation's identity. */
export function matchesResume(
  prev: RunState | null,
  cur: { bin: string; mode: string; inputs: string }
): boolean {
  return (
    prev != null &&
    prev.status !== "complete" &&
    prev.bin === cur.bin &&
    prev.mode === cur.mode &&
    prev.inputs === cur.inputs
  );
}
