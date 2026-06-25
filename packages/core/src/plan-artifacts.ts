import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type TaskPlanDocument = {
  taskKey: string;
  specPath: string;
  planPath: string;
  doc: string;
  updatedMs: number;
};

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function updatedMs(paths: string[]): number {
  let latest = 0;
  for (const p of paths) {
    try {
      latest = Math.max(latest, statSync(p).mtimeMs);
    } catch {
      // Missing spec.md or plan.md is fine; callers score whatever exists.
    }
  }
  return latest;
}

export function readTaskPlanDocuments(
  workspaceDir: string
): TaskPlanDocument[] {
  const tasksDir = join(workspaceDir, ".otto", "tasks");
  let entries: string[];
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const docs: TaskPlanDocument[] = [];
  for (const taskKey of entries) {
    const specPath = join(".otto", "tasks", taskKey, "spec.md");
    const planPath = join(".otto", "tasks", taskKey, "plan.md");
    const absSpec = join(workspaceDir, specPath);
    const absPlan = join(workspaceDir, planPath);
    const doc = [readOptional(absSpec), readOptional(absPlan)].join("\n");
    if (doc.trim() === "") continue;
    docs.push({
      taskKey,
      specPath,
      planPath,
      doc,
      updatedMs: updatedMs([absSpec, absPlan]),
    });
  }
  return docs;
}

export function latestTaskPlanDocument(
  workspaceDir: string
): TaskPlanDocument | null {
  const docs = readTaskPlanDocuments(workspaceDir);
  if (docs.length === 0) return null;
  return docs
    .slice()
    .sort(
      (a, b) => a.updatedMs - b.updatedMs || a.taskKey.localeCompare(b.taskKey)
    )
    .at(-1)!;
}
