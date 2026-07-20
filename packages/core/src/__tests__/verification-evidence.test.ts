import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
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
    expect(e.artifactBundled).toBe(true);
    expect(
      existsSync(join(dir, ".otto", "runs", "run-1", e.artifactPath!))
    ).toBe(true);
  });

  it("rejects a verification/ dir symlinked elsewhere INSIDE the workspace (#181 boundary review)", () => {
    const dir = ws();
    mkdirSync(join(dir, ".otto-tmp"), { recursive: true });
    writeFileSync(join(dir, ".otto-tmp", "s.png"), "PNG");
    // A redirect target that is still inside the workspace (e.g. a source dir).
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".otto", "runs", "run-1"), { recursive: true });
    symlinkSync(
      join(dir, "src"),
      join(dir, ".otto", "runs", "run-1", "verification")
    );

    const [e] = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: ".otto-tmp/s.png" })],
      { workspaceDir: dir, runId: "run-1", ...noGit }
    );
    // Not bundled, not redirected into src/.
    expect(e.artifactBundled).toBeFalsy();
    expect(e.artifactPath).toBe(".otto-tmp/s.png");
    expect(readdirSync(join(dir, "src"))).toEqual([]);
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

  it("refuses to relocate through a symlinked destination dir (#181 boundary review)", () => {
    const dir = ws();
    const outside = mkdtempSync(join(tmpdir(), "otto-outside-"));
    roots.push(outside);
    mkdirSync(join(dir, ".otto-tmp"), { recursive: true });
    writeFileSync(join(dir, ".otto-tmp", "s.png"), "PNG");
    // Make the bundle's verification dir a symlink pointing outside the workspace.
    mkdirSync(join(dir, ".otto", "runs", "run-1"), { recursive: true });
    symlinkSync(outside, join(dir, ".otto", "runs", "run-1", "verification"));

    const [e] = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: ".otto-tmp/s.png" })],
      { workspaceDir: dir, runId: "run-1", ...noGit }
    );
    // The copy is refused (path left un-relocated) and nothing escapes the workspace.
    expect(e.artifactPath).toBe(".otto-tmp/s.png");
    expect(readdirSync(outside)).toEqual([]);
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

describe("produced-this-run enforcement (issue #201)", () => {
  function scratchShot(dir: string, ageMs: number): string {
    mkdirSync(join(dir, ".otto-tmp", "shots"), { recursive: true });
    const p = join(dir, ".otto-tmp", "shots", "after.png");
    writeFileSync(p, "png-bytes");
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
    return ".otto-tmp/shots/after.png";
  }

  it("rejects a scratch artifact older than the run start — neither bundled nor counted", () => {
    const dir = ws();
    const rel = scratchShot(dir, 60_000); // written a minute "before" the run
    const out = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: rel })],
      {
        workspaceDir: dir,
        runId: "r1",
        startedAtMs: Date.now() - 1_000,
        ...noGit,
      }
    );
    expect(out[0]?.artifactBundled).toBe(false);
    expect(out[0]?.artifactExists).toBe(false);
    expect(out[0]?.artifactPath).toBe(rel); // left in place, never relocated
  });

  it("bundles a scratch artifact created after the run start", () => {
    const dir = ws();
    const rel = scratchShot(dir, 0);
    const out = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: rel })],
      {
        workspaceDir: dir,
        runId: "r1",
        startedAtMs: Date.now() - 60_000,
        ...noGit,
      }
    );
    expect(out[0]?.artifactBundled).toBe(true);
    expect(out[0]?.artifactExists).toBe(true);
  });

  it("also refuses to relocate a stale before-screenshot", () => {
    const dir = ws();
    const rel = scratchShot(dir, 60_000);
    const out = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: "a.ts:1", beforePath: rel })],
      {
        workspaceDir: dir,
        runId: "r1",
        startedAtMs: Date.now() - 1_000,
        ...noGit,
      }
    );
    expect(out[0]?.beforeBundled).toBe(false);
    expect(out[0]?.beforePath).toBe(rel);
  });

  it("bundles a scratch artifact whose mtime is floored just before the run start (coarse-FS granularity)", () => {
    // Regression for a flaky CI failure: a container/overlay filesystem floors
    // mtime to ~1s, so a screenshot written right after the run started reads a
    // hair OLDER than the sub-ms startedAtMs. Within the granularity slop it must
    // still be treated as produced-this-run and relocated.
    const dir = ws();
    const rel = scratchShot(dir, 1_000); // 1s "before" now — inside the 2s slop
    const out = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: rel })],
      {
        workspaceDir: dir,
        runId: "r1",
        startedAtMs: Date.now(), // run "started" now; file is ~1s older by mtime
        ...noGit,
      }
    );
    expect(out[0]?.artifactBundled).toBe(true);
    expect(out[0]?.artifactExists).toBe(true);
  });

  it("still rejects a scratch artifact older than the run start beyond the slop", () => {
    const dir = ws();
    const rel = scratchShot(dir, 10_000); // 10s old — well past the 2s slop
    const out = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: rel })],
      { workspaceDir: dir, runId: "r1", startedAtMs: Date.now(), ...noGit }
    );
    expect(out[0]?.artifactBundled).toBe(false);
    expect(out[0]?.artifactPath).toBe(rel);
  });

  it("without startedAtMs keeps the pre-#201 behavior (no mtime check)", () => {
    const dir = ws();
    const rel = scratchShot(dir, 60_000);
    const out = validateVerificationEvidence(
      [entry({ method: "visual", artifactPath: rel })],
      { workspaceDir: dir, runId: "r1", ...noGit }
    );
    expect(out[0]?.artifactBundled).toBe(true);
  });
});
