/**
 * Exact review-input resolution and artifact (P32 Task 5).
 *
 * An operator may hand an unattended PR-review run zero or one *review intent*
 * source — nothing, a GitHub issue, a local file, or a direct prompt. This
 * module turns that request into an exact, deterministic {@link
 * ResolvedReviewInput} snapshot: a SHA-256 fingerprint over `kind`, canonical
 * `source`, and verbatim `content`, plus a retrievable on-disk artifact.
 *
 * This is a security / trust boundary. The resolved content is UNTRUSTED text a
 * contributor could copy into an issue or file (taint source `review-input`),
 * and the file path is attacker-influenceable. Every validation is exact and
 * FAIL-CLOSED *before* any artifact write or model call: absolute/`..`
 * traversal, symlinks, non-regular files, targets escaping the workspace,
 * unsupported extensions, invalid UTF-8, and CR/LF/NUL in the recorded source
 * path (which would let untrusted text forge the harness-owned artifact header)
 * all throw a {@link ReviewInputError} and never produce a snapshot.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitHubPrClient } from "./github-pr.js";
import type { ReviewInputRequest } from "./review-cli.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An exact, deterministic snapshot of the resolved review intent. */
export type ResolvedReviewInput = {
  kind: ReviewInputRequest["kind"];
  source: string;
  fingerprint: string;
  content: string;
};

/** A {@link ResolvedReviewInput} plus its written on-disk artifact path. */
export type ReviewInputSnapshot = ResolvedReviewInput & {
  artifactPath: string;
};

export type ReviewInputErrorKind =
  | "validation"
  | "not-found"
  | "encoding"
  | "io"
  | "malformed";

/** Fail-closed error for every rejected review-input case. */
export class ReviewInputError extends Error {
  readonly kind: ReviewInputErrorKind;
  constructor(kind: ReviewInputErrorKind, message: string) {
    super(message);
    this.name = "ReviewInputError";
    this.kind = kind;
  }
}

/** Injectable FS surface so traversal/symlink/special-file cases are hermetic. */
export type ReviewInputFs = {
  lstat: (path: string) => Stats;
  realpath: (path: string) => string;
  readFile: (path: string) => Buffer;
};

const DEFAULT_FS: ReviewInputFs = {
  lstat: (p) => lstatSync(p),
  realpath: (p) => realpathSync(p),
  readFile: (p) => readFileSync(p),
};

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Lower-case SHA-256 over `kind \0 source \0 content`. The NUL separators keep
 * field boundaries unambiguous so distinct (kind, source, content) triples
 * cannot collide by concatenation. `state`/`updatedAt` of an issue are
 * deliberately excluded: only review *intent* — kind, canonical source, and
 * verbatim content — participates.
 */
export function reviewInputFingerprint(
  kind: ReviewInputRequest["kind"],
  source: string,
  content: string
): string {
  return createHash("sha256")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(source, "utf8")
    .update("\0", "utf8")
    .update(content, "utf8")
    .digest("hex");
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Accept exactly 64 lower-case hex characters; reject anything else. */
export function parseReviewInputFingerprint(raw: string): string {
  if (!FINGERPRINT_RE.test(raw)) {
    throw new ReviewInputError(
      "malformed",
      `fingerprint must be 64 lower-case hex characters, got: ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Issue-ref parsing
// ---------------------------------------------------------------------------

// Strict: no trailing path/query/fragment, GitHub host only, /issues/ only.
const ISSUE_URL_RE =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)$/i;

function splitRepository(repository: string): { owner: string; name: string } {
  const slash = repository.indexOf("/");
  return {
    owner: slash >= 0 ? repository.slice(0, slash) : repository,
    name: slash >= 0 ? repository.slice(slash + 1) : "",
  };
}

/**
 * Normalize a spec-issue ref to a safe positive integer. Accepts a bare
 * positive integer (`[1-9]\d*`) or `https://github.com/<owner>/<repo>/issues/N`
 * whose lower-cased owner/repo matches `repository`. Rejects PR URLs, query
 * strings/fragments, cross-repository URLs, non-GitHub hosts, and unsafe or
 * malformed numbers.
 */
export function parseSpecIssueRef(raw: string, repository: string): number {
  const s = raw.trim();
  let numStr: string;
  let urlOwner: string | undefined;
  let urlRepo: string | undefined;

  if (/^[1-9]\d*$/.test(s)) {
    numStr = s;
  } else {
    const m = s.match(ISSUE_URL_RE);
    if (!m) {
      throw new ReviewInputError(
        "validation",
        `--spec-issue must be a positive integer or a GitHub issue URL, got: ${JSON.stringify(raw)}`
      );
    }
    urlOwner = m[1];
    urlRepo = m[2];
    numStr = m[3];
  }

  const n = Number.parseInt(numStr, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ReviewInputError(
      "validation",
      `--spec-issue number is invalid or too large, got: ${JSON.stringify(raw)}`
    );
  }

  if (urlOwner !== undefined && urlRepo !== undefined) {
    const { owner, name } = splitRepository(repository);
    if (
      urlOwner.toLowerCase() !== owner.toLowerCase() ||
      urlRepo.toLowerCase() !== name.toLowerCase()
    ) {
      throw new ReviewInputError(
        "validation",
        `--spec-issue URL repository (${urlOwner}/${urlRepo}) does not match --repo ${repository}`
      );
    }
  }

  return n;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const ALLOWED_EXT = new Set([".txt", ".md", ".markdown"]);

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf(sep));
  if (dot <= slash) return "";
  return path.slice(dot).toLowerCase();
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Resolve a review-input request to an exact snapshot (no artifact written).
 * Every failure throws {@link ReviewInputError} before any I/O side effect,
 * so a caller can safely write the artifact / call the model only on success.
 */
export function resolveReviewInput(opts: {
  workspaceDir: string;
  repository: string;
  request: ReviewInputRequest;
  github?: Pick<GitHubPrClient, "getIssue">;
  fs?: ReviewInputFs;
}): ResolvedReviewInput {
  const { workspaceDir, repository, request } = opts;
  const fs = opts.fs ?? DEFAULT_FS;

  switch (request.kind) {
    case "none": {
      const source = "none";
      const content = "";
      return {
        kind: "none",
        source,
        content,
        fingerprint: reviewInputFingerprint("none", source, content),
      };
    }

    case "prompt": {
      if (request.text.trim() === "") {
        throw new ReviewInputError(
          "validation",
          "--prompt must not be empty or whitespace-only"
        );
      }
      const source = "direct";
      const content = request.text; // exact, incl. leading/trailing whitespace
      return {
        kind: "prompt",
        source,
        content,
        fingerprint: reviewInputFingerprint("prompt", source, content),
      };
    }

    case "github-issue": {
      // Validate the ref BEFORE any adapter call.
      const number = parseSpecIssueRef(request.ref, repository);
      if (!opts.github) {
        throw new ReviewInputError(
          "validation",
          "a GitHub client is required to resolve a github-issue review input"
        );
      }
      const spec = opts.github.getIssue(repository, number);
      if (spec.number !== number) {
        throw new ReviewInputError(
          "validation",
          `resolved issue number ${spec.number} does not match requested ${number}`
        );
      }
      const m = spec.url.match(ISSUE_URL_RE);
      const { owner, name } = splitRepository(repository);
      if (
        !m ||
        m[1].toLowerCase() !== owner.toLowerCase() ||
        m[2].toLowerCase() !== name.toLowerCase()
      ) {
        throw new ReviewInputError(
          "validation",
          `resolved issue URL ${JSON.stringify(spec.url)} does not match --repo ${repository}`
        );
      }
      const source = spec.url;
      const content = `${spec.title}\n\n${spec.body}`;
      return {
        kind: "github-issue",
        source,
        content,
        fingerprint: reviewInputFingerprint("github-issue", source, content),
      };
    }

    case "local-file":
      return resolveLocalFile(workspaceDir, request.path, fs);
  }
}

function resolveLocalFile(
  workspaceDir: string,
  rawPath: string,
  fs: ReviewInputFs
): ResolvedReviewInput {
  if (rawPath === "" || rawPath.includes("\0")) {
    throw new ReviewInputError("validation", "review-input path is invalid");
  }
  if (isAbsolute(rawPath)) {
    throw new ReviewInputError(
      "validation",
      `review-input path must be workspace-relative, got: ${JSON.stringify(rawPath)}`
    );
  }

  // Lexical containment: reject `..` traversal before touching the FS.
  const lexical = resolve(workspaceDir, rawPath);
  const lexRel = relative(workspaceDir, lexical);
  if (
    lexRel === "" ||
    lexRel === ".." ||
    lexRel.startsWith(".." + sep) ||
    isAbsolute(lexRel)
  ) {
    throw new ReviewInputError(
      "validation",
      `review-input path escapes the workspace: ${JSON.stringify(rawPath)}`
    );
  }

  // lstat BEFORE realpath: a symlink must be rejected as itself, not followed.
  let stat: Stats;
  try {
    stat = fs.lstat(lexical);
  } catch {
    throw new ReviewInputError(
      "not-found",
      `review-input file not found: ${JSON.stringify(rawPath)}`
    );
  }
  if (stat.isSymbolicLink()) {
    throw new ReviewInputError(
      "validation",
      `review-input path is a symlink: ${JSON.stringify(rawPath)}`
    );
  }
  if (!stat.isFile()) {
    throw new ReviewInputError(
      "validation",
      `review-input path is not a regular file: ${JSON.stringify(rawPath)}`
    );
  }

  // Real containment: the real target must stay under the real workspace.
  let realTarget: string;
  let realWorkspace: string;
  try {
    realTarget = fs.realpath(lexical);
    realWorkspace = fs.realpath(workspaceDir);
  } catch {
    throw new ReviewInputError(
      "not-found",
      `review-input file not found: ${JSON.stringify(rawPath)}`
    );
  }
  const realRel = relative(realWorkspace, realTarget);
  if (
    realRel === "" ||
    realRel === ".." ||
    realRel.startsWith(".." + sep) ||
    isAbsolute(realRel)
  ) {
    throw new ReviewInputError(
      "validation",
      `review-input real target escapes the workspace: ${JSON.stringify(rawPath)}`
    );
  }

  if (!ALLOWED_EXT.has(extensionOf(realTarget))) {
    throw new ReviewInputError(
      "validation",
      `review-input file must be .txt, .md, or .markdown: ${JSON.stringify(rawPath)}`
    );
  }

  // Workspace-relative POSIX source; reject CR/LF/NUL so it cannot forge the
  // harness-owned artifact header lines.
  const source = toPosix(realRel);
  if (/[\r\n\0]/.test(source)) {
    throw new ReviewInputError(
      "validation",
      `review-input path contains an illegal character: ${JSON.stringify(rawPath)}`
    );
  }

  const bytes = fs.readFile(realTarget);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReviewInputError(
      "encoding",
      `review-input file is not valid UTF-8: ${JSON.stringify(rawPath)}`
    );
  }
  if (content === "") {
    throw new ReviewInputError(
      "validation",
      `review-input file is empty: ${JSON.stringify(rawPath)}`
    );
  }

  return {
    kind: "local-file",
    source,
    content,
    fingerprint: reviewInputFingerprint("local-file", source, content),
  };
}

// ---------------------------------------------------------------------------
// Artifact: render / write / read
// ---------------------------------------------------------------------------

const ARTIFACT_HEAD = "# Otto review input\n\nKind: ";
const ARTIFACT_MID = "\n## Untrusted review intent\n\n";
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const VALID_KINDS: readonly ReviewInputRequest["kind"][] = [
  "none",
  "github-issue",
  "local-file",
  "prompt",
];

/**
 * Emit the fixed harness-owned header followed by the exact content. The
 * content is DATA: Markdown headings, `</untrusted>`, or apparent agent
 * commands inside it stay verbatim after the fixed heading — they are never
 * interpreted as structure here.
 */
export function renderReviewInputArtifact(input: ResolvedReviewInput): string {
  return (
    `# Otto review input\n\n` +
    `Kind: ${input.kind}\n` +
    `Source: ${input.source}\n` +
    `Fingerprint: ${input.fingerprint}\n\n` +
    `## Untrusted review intent\n\n` +
    input.content
  );
}

function validateRunId(runId: string): void {
  if (runId === "." || runId === ".." || !RUN_ID_RE.test(runId)) {
    throw new ReviewInputError(
      "validation",
      `invalid run id: ${JSON.stringify(runId)}`
    );
  }
}

/** Workspace-relative POSIX path of the artifact for a run. */
function artifactRelPath(runId: string): string {
  return `.otto/runs/${runId}/review-input.md`;
}

/**
 * Write the artifact atomically to `.otto/runs/<run-id>/review-input.md`:
 * sibling temp file, `fsync`, close, then `rename`. Returns the snapshot with
 * the workspace-relative POSIX artifact path.
 */
export function writeReviewInputArtifact(opts: {
  workspaceDir: string;
  runId: string;
  input: ResolvedReviewInput;
}): ReviewInputSnapshot {
  const { workspaceDir, runId, input } = opts;
  validateRunId(runId);
  parseReviewInputFingerprint(input.fingerprint);

  const dir = join(workspaceDir, ".otto", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, "review-input.md");
  const tmpPath = join(dir, `review-input.md.tmp-${process.pid}`);
  const body = renderReviewInputArtifact(input);

  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);

  return { ...input, artifactPath: artifactRelPath(runId) };
}

/**
 * Read and verify the artifact for a run. Returns `null` on ANY schema,
 * identity, content, path, or fingerprint mismatch (a symlinked artifact, a
 * malformed header, tampered content, or a wrong expected fingerprint all read
 * as absent), never a partially-trusted value.
 */
export function readReviewInputArtifact(opts: {
  workspaceDir: string;
  runId: string;
  expectedFingerprint: string;
}): ReviewInputSnapshot | null {
  const { workspaceDir, runId, expectedFingerprint } = opts;

  if (runId === "." || runId === ".." || !RUN_ID_RE.test(runId)) return null;
  if (!FINGERPRINT_RE.test(expectedFingerprint)) return null;

  const finalPath = join(
    workspaceDir,
    ".otto",
    "runs",
    runId,
    "review-input.md"
  );

  // Reject a symlink (and a missing file) as absent.
  let stat: Stats;
  try {
    stat = lstatSync(finalPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null; // rejects symlink, dir, fifo, etc.

  let text: string;
  try {
    text = readFileSync(finalPath, "utf8");
  } catch {
    return null;
  }

  // Parse ONLY the fixed header positions.
  if (!text.startsWith(ARTIFACT_HEAD)) return null;
  let rest = text.slice(ARTIFACT_HEAD.length);

  const kEnd = rest.indexOf("\n");
  if (kEnd < 0) return null;
  const kind = rest.slice(0, kEnd) as ReviewInputRequest["kind"];
  if (!VALID_KINDS.includes(kind)) return null;
  rest = rest.slice(kEnd + 1);

  if (!rest.startsWith("Source: ")) return null;
  rest = rest.slice("Source: ".length);
  const sEnd = rest.indexOf("\n");
  if (sEnd < 0) return null;
  const source = rest.slice(0, sEnd);
  rest = rest.slice(sEnd + 1);

  if (!rest.startsWith("Fingerprint: ")) return null;
  rest = rest.slice("Fingerprint: ".length);
  const fEnd = rest.indexOf("\n");
  if (fEnd < 0) return null;
  const fingerprint = rest.slice(0, fEnd);
  rest = rest.slice(fEnd + 1);

  if (!FINGERPRINT_RE.test(fingerprint)) return null;

  if (!rest.startsWith(ARTIFACT_MID)) return null;
  const content = rest.slice(ARTIFACT_MID.length);

  // Recompute + verify identity, then match the caller's expectation.
  if (reviewInputFingerprint(kind, source, content) !== fingerprint)
    return null;
  if (fingerprint !== expectedFingerprint) return null;

  return {
    kind,
    source,
    fingerprint,
    content,
    artifactPath: artifactRelPath(runId),
  };
}
