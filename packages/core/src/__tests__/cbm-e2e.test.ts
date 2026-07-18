import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createStdioCbmRunner } from "../codebase-memory-adapter.js";
import { runIndexRepository } from "../cbm-index.js";

// Real codebase-memory binary, no injected stub — proves the stdio adapter can
// actually round-trip a JSON-RPC call against an operator-provided Codebase
// Memory server (codebase-memory-adapter.test.ts already covers the parser and
// tool-definition shape against a stub). Gated behind OTTO_CBM_E2E=1 so the
// normal suite never requires the binary. Run it with:
//   OTTO_CBM_E2E=1 pnpm --filter @phamvuhoang/otto-core test -- cbm-e2e
// (the pinned binary must be installed and resolvable as `codebase-memory` on
// PATH, or point the runner at it via cwd/PATH before running).
const optedIn = process.env.OTTO_CBM_E2E === "1";
const runner = optedIn
  ? createStdioCbmRunner("codebase-memory", process.cwd(), 120_000)
  : null;
const maybe = optedIn && runner?.available() ? it : it.skip;

/**
 * Recursive file lister rooted at `dir`, returning absolute paths — matching
 * the shape `declaredRoots` is compared against in {@link diffWriteInventory}
 * (production's `listCbmFilesRel` in loop.ts uses workspace-relative paths
 * instead, but the confinement check is the same: every listed path must
 * fall under a declared root).
 */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  try {
    walk(dir);
  } catch {
    /* dir doesn't exist yet — no files */
  }
  return out;
}

describe("codebase-memory real binary (gated)", () => {
  maybe("answers an architecture query over stdio", () => {
    const res = runner!.call({ operation: "get_architecture", params: {} });
    expect(res.ok).toBe(true);
  });

  // Confined-write proof against a *real* binary: index a throwaway scratch
  // dir and assert every write it produced landed under the declared root
  // (mirrors cbm-index.test.ts's stubbed-runner cases, but here nothing is
  // stubbed — the binary itself does the writing).
  maybe("indexes into a confined temp scratch with no escaped writes", () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "otto-cbm-e2e-"));
    const scratchDir = join(scratchRoot, "cbm-scratch");
    mkdirSync(scratchDir, { recursive: true });
    try {
      const result = runIndexRepository({
        runner: runner!,
        scratchDir,
        declaredRoots: [scratchDir],
        snapshot: listFiles,
        identity: {
          workspace: scratchRoot,
          sourceRevision: "e2e",
          worktreeDirty: false,
          toolVersion: "e2e",
          indexedAt: new Date().toISOString(),
        },
      });
      expect(result.ok).toBe(true);
      expect(result.writeInventory.escaped.length).toBe(0);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
