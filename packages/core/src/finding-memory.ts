/**
 * Cross-iteration finding memory (P28, issue #248).
 *
 * The review loop could re-raise a defect it had already "fixed" and nothing
 * noticed: each iteration's findings were compared against nothing. This
 * records which iterations raised each finding signature, so a defect that
 * comes back is visible as a recurrence rather than silently re-entering the
 * fix cycle.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runReportDir } from "./run-report.js";
import { findingSignature } from "./review-severity.js";
import type { Finding, Severity } from "./review-severity.js";

export type FindingMemoryEntry = {
  signature: string;
  severity: Severity;
  file: string;
  claim: string;
  /** Distinct iteration numbers that raised this finding, ascending. */
  iterations: number[];
};

export type FindingMemory = { entries: FindingMemoryEntry[] };

export function emptyFindingMemory(): FindingMemory {
  return { entries: [] };
}

/**
 * Fold this iteration's findings into the memory. Pure.
 *
 * `recurring` is the set of entries now seen in **two or more distinct
 * iterations**. Two lenses raising the same defect within a single iteration is
 * a dedupe concern, not a regression, so an iteration is recorded at most once
 * per signature and never looks like a re-raise.
 */
export function recordFindings(
  memory: FindingMemory,
  iteration: number,
  findings: Finding[]
): { memory: FindingMemory; recurring: FindingMemoryEntry[] } {
  const bySig = new Map(memory.entries.map((e) => [e.signature, { ...e }]));
  const touched = new Set<string>();
  for (const f of findings) {
    const signature = findingSignature(f);
    touched.add(signature);
    const existing = bySig.get(signature);
    if (existing) {
      if (!existing.iterations.includes(iteration)) {
        existing.iterations = [...existing.iterations, iteration].sort(
          (a, b) => a - b
        );
      }
    } else {
      bySig.set(signature, {
        signature,
        severity: f.severity,
        file: f.file,
        claim: f.claim,
        iterations: [iteration],
      });
    }
  }
  const entries = [...bySig.values()];
  const recurring = entries.filter(
    (e) => touched.has(e.signature) && e.iterations.length >= 2
  );
  return { memory: { entries }, recurring };
}

function memoryPath(workspaceDir: string, runId: string): string {
  return join(runReportDir(workspaceDir, runId), "findings.json");
}

/** Absent or malformed ⇒ empty. Never throws — a broken file must not fail a run. */
export function readFindingMemory(
  workspaceDir: string,
  runId: string
): FindingMemory {
  try {
    const raw = JSON.parse(
      readFileSync(memoryPath(workspaceDir, runId), "utf8")
    ) as FindingMemory;
    if (!raw || !Array.isArray(raw.entries)) return emptyFindingMemory();
    return raw;
  } catch {
    return emptyFindingMemory();
  }
}

/** Best-effort persist, mirroring `writeRunReport`: a write failure is swallowed. */
export function writeFindingMemory(
  workspaceDir: string,
  runId: string,
  memory: FindingMemory
): void {
  try {
    const p = memoryPath(workspaceDir, runId);
    mkdirSync(runReportDir(workspaceDir, runId), { recursive: true });
    writeFileSync(p, `${JSON.stringify(memory, null, 2)}\n`);
  } catch {
    // Never fail a run because finding memory could not be written.
  }
}
