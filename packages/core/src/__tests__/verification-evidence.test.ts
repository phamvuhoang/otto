import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  artifactReferenceExists,
  validateVerificationEvidence,
} from "../verification-evidence.js";
import type { VerificationEntry } from "../verification-matrix.js";

const roots: string[] = [];
function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "otto-evidence-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const noGit = { commitExists: () => false };
const yesGit = { commitExists: () => true };

const entry = (over: Partial<VerificationEntry>): VerificationEntry => ({
  requirement: "r",
  method: "test",
  check: "node --test",
  result: "pass",
  confidence: "high",
  ...over,
});

describe("artifactReferenceExists", () => {
  it("accepts a file:line whose file exists and line is in bounds", () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "l1\nl2\nl3\n");
    expect(artifactReferenceExists("a.ts:2", dir, noGit)).toBe(true);
    expect(artifactReferenceExists("a.ts:1-3", dir, noGit)).toBe(true);
  });

  it("rejects a nonexistent file and an out-of-bounds line", () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "l1\nl2\n");
    expect(
      artifactReferenceExists("proof/does-not-exist.txt", dir, noGit)
    ).toBe(false);
    expect(artifactReferenceExists("a.ts:99", dir, noGit)).toBe(false);
  });

  it("rejects absolute and traversal escapes even if the target exists", () => {
    const dir = ws();
    expect(artifactReferenceExists("/etc/hosts", dir, noGit)).toBe(false);
    expect(artifactReferenceExists("../../etc/hosts", dir, noGit)).toBe(false);
  });

  it("confirms a SHA only when git says it exists", () => {
    const dir = ws();
    expect(artifactReferenceExists("a1b2c3d", dir, yesGit)).toBe(true);
    expect(artifactReferenceExists("a1b2c3d", dir, noGit)).toBe(false);
  });
});

describe("validateVerificationEvidence", () => {
  it("marks nonexistent artifacts so they do not earn coverage", () => {
    const dir = ws();
    const [e] = validateVerificationEvidence(
      [entry({ artifactPath: "proof/missing.txt" })],
      { workspaceDir: dir, runId: "run-1", ...noGit }
    );
    expect(e.artifactExists).toBe(false);
    expect(e.artifactPath).toBe("proof/missing.txt"); // not relocated (escaped/absent)
  });

  it("relocates a scratch screenshot into the bundle with a report-relative path", () => {
    const dir = ws();
    mkdirSync(join(dir, ".otto-tmp", "shots"), { recursive: true });
    writeFileSync(join(dir, ".otto-tmp", "shots", "after.png"), "PNG");
    const [e] = validateVerificationEvidence(
      [
        entry({
          method: "visual",
          artifactPath: ".otto-tmp/shots/after.png",
        }),
      ],
      { workspaceDir: dir, runId: "run-1", ...noGit }
    );
    expect(e.artifactPath).toMatch(/^verification\//);
    expect(e.artifactExists).toBe(true);
    expect(
      existsSync(join(dir, ".otto", "runs", "run-1", e.artifactPath!))
    ).toBe(true);
  });

  it("never copies a file outside the workspace", () => {
    const dir = ws();
    const [e] = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: "/etc/hosts" })],
      { workspaceDir: dir, runId: "run-1", ...noGit }
    );
    // Left as-is (not relocated), and flagged non-existent for coverage.
    expect(e.artifactPath).toBe("/etc/hosts");
    expect(e.artifactExists).toBe(false);
    expect(
      existsSync(join(dir, ".otto", "runs", "run-1", "verification"))
    ).toBe(false);
  });

  it("does not relocate an in-repo file outside .otto-tmp (#181 re-review, finding 1)", () => {
    const dir = ws();
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "shot.png"), "PNG");
    const [e] = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: "docs/shot.png" })],
      { workspaceDir: dir, runId: "run-1", ...noGit }
    );
    // It exists (counts for coverage) but is left in place — only scratch
    // artifacts under .otto-tmp/ are copied into the bundle.
    expect(e.artifactExists).toBe(true);
    expect(e.artifactPath).toBe("docs/shot.png");
  });

  it("relocates a non-visual transcript artifact too (#181 re-review)", () => {
    const dir = ws();
    mkdirSync(join(dir, ".otto-tmp"), { recursive: true });
    writeFileSync(join(dir, ".otto-tmp", "run.log"), "transcript");
    const [e] = validateVerificationEvidence(
      [entry({ method: "command", artifactPath: ".otto-tmp/run.log" })],
      { workspaceDir: dir, runId: "run-1", ...noGit }
    );
    expect(e.artifactPath).toMatch(/^verification\//);
  });
});
