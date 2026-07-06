import { pathsCollide } from "./plan-tasks.js";

/** One test invocation reported by a sub-agent, and whether it passed. */
export type TestRun = { command: string; passed: boolean };

/**
 * Structured handoff a fan-out sub-agent reports back to the orchestrator:
 * what it touched, what it ran, what's risky or deferred, and (once computed)
 * which changed files fell outside its declared file scope.
 */
export type SubAgentHandoff = {
  taskId: string;
  changedFiles: string[];
  testsRun: TestRun[];
  risks: string[];
  deferred: string[];
  outOfScopeFiles: string[];
};

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Changed files not covered by any `fileScope` entry (via {@link pathsCollide}).
 * Empty `fileScope` means no scope was declared, so nothing is flagged.
 */
export function computeOutOfScope(
  changedFiles: string[],
  fileScope: string[]
): string[] {
  if (fileScope.length === 0) return [];
  return changedFiles.filter((f) => !fileScope.some((s) => pathsCollide(f, s)));
}

/**
 * Parse a sub-agent's `handoff.json` payload. Throws-free: valid JSON is
 * normalized field-by-field (wrong-typed or missing fields degrade to safe
 * defaults); anything that isn't a JSON object (parse failure, `null`, an
 * array, a primitive) falls back to a minimal handoff built from
 * `changedFilesFallback` (e.g. the actual worktree diff).
 */
export function parseHandoff(
  raw: string,
  taskId: string,
  changedFilesFallback: string[]
): SubAgentHandoff {
  const minimal: SubAgentHandoff = {
    taskId,
    changedFiles: changedFilesFallback,
    testsRun: [],
    risks: [],
    deferred: [],
    outOfScopeFiles: [],
  };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return minimal;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return minimal;
  const o = obj as Record<string, unknown>;
  const parsedChangedFiles = strArr(o.changedFiles);
  const changedFiles = parsedChangedFiles.length
    ? parsedChangedFiles
    : changedFilesFallback;
  const testsRun: TestRun[] = Array.isArray(o.testsRun)
    ? o.testsRun
        .filter(
          (t): t is { command: string; passed?: unknown } =>
            !!t &&
            typeof t === "object" &&
            typeof (t as any).command === "string"
        )
        .map((t) => ({ command: t.command, passed: t.passed === true }))
    : [];
  return {
    taskId,
    changedFiles,
    testsRun,
    risks: strArr(o.risks),
    deferred: strArr(o.deferred),
    outOfScopeFiles: strArr(o.outOfScopeFiles),
  };
}
