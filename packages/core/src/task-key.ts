/**
 * The shared "work scope + task key" contract (issue #21, P0).
 *
 * A {@link WorkScope} answers *where* Otto may look for work (used by watch
 * scoping and `--print-config`). A {@link WorkSource} is a scope plus the
 * specific item, and {@link deriveTaskKey} turns it into one normalized key that
 * is reused for artifact paths and branch names across every provider — so
 * scoped watch, branch naming, and artifact storage stay drift-free.
 */

/** Where Otto may look for work — no specific item yet (watch / print-config). */
export type WorkScope =
  | { provider: "plan" }
  | { provider: "github"; owner?: string; repo?: string }
  | { provider: "linear"; team?: string; project?: string };

/** A scope plus the concrete item it points at (names artifacts + branches). */
export type WorkSource =
  | { provider: "plan"; slug: string }
  | {
      provider: "github";
      owner?: string;
      repo?: string;
      issue: number;
      slug?: string;
    }
  | {
      provider: "linear";
      team?: string;
      project?: string;
      issue: string;
      slug?: string;
    };

/**
 * Lowercase, collapse every non-`[a-z0-9]` run to a single dash, and trim
 * leading/trailing dashes. The result contains only `[a-z0-9-]`, which is both
 * filesystem-safe and git-branch-safe (mirrors `slugify` in branch.ts). "" when
 * nothing usable remains.
 */
function sanitize(part: string): string {
  return part
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SLUG_MAX = 40;

/** Sanitize + cap a free-text slug at {@link SLUG_MAX} chars (matches slugify). */
function slugPart(slug: string): string {
  return sanitize(slug).slice(0, SLUG_MAX).replace(/-+$/g, "");
}

/**
 * Derive the one normalized, filesystem-safe and git-branch-safe task key for a
 * work source. Optional scope parts (owner/repo, team/project) and the slug drop
 * out of the key when absent. Shapes:
 *
 * - plan:   `plan-<slug>`
 * - github: `gh-<owner>-<repo>-<issue>[-<slug>]` (→ `gh-<issue>[-<slug>]` w/o scope)
 * - linear: `linear-<team>-<project>-<issue>[-<slug>]` (optional parts omitted)
 */
export function deriveTaskKey(source: WorkSource): string {
  let parts: string[];
  switch (source.provider) {
    case "plan":
      parts = ["plan", slugPart(source.slug)];
      break;
    case "github":
      parts = [
        "gh",
        source.owner ? sanitize(source.owner) : "",
        source.repo ? sanitize(source.repo) : "",
        String(source.issue),
        source.slug ? slugPart(source.slug) : "",
      ];
      break;
    case "linear":
      parts = [
        "linear",
        source.team ? sanitize(source.team) : "",
        source.project ? sanitize(source.project) : "",
        sanitize(source.issue),
        source.slug ? slugPart(source.slug) : "",
      ];
      break;
  }
  return parts.filter(Boolean).join("-");
}

// GitHub owner (user/org): alphanumeric or single hyphens, no leading/trailing
// hyphen. Repo name: alphanumeric plus `.`, `_`, `-` — but never the reserved
// `.`/`..`. Both admit only shell-safe chars, so the resulting `owner/repo` is
// safe to reach a host shell (the `gh issue list --repo` poller arg + the
// `$OTTO_GITHUB_REPO` env the ghafk templates interpolate).
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Parse + validate a user-supplied `owner/repo` (from `--repo` or
 * `OTTO_GITHUB_REPO`) into its parts. Throws on anything malformed or that
 * carries shell metacharacters, so the validated result is safe to pass to
 * `gh` and to export as `OTTO_GITHUB_REPO`. The original case is preserved
 * (gh's display form); {@link deriveTaskKey} lowercases when it builds keys.
 */
export function parseGithubRepo(raw: string): { owner: string; repo: string } {
  const s = raw.trim();
  const slash = s.indexOf("/");
  const owner = slash >= 0 ? s.slice(0, slash) : "";
  const repo = slash >= 0 ? s.slice(slash + 1) : "";
  if (
    !OWNER_RE.test(owner) ||
    !REPO_RE.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw new Error(
      `--repo must be a valid GitHub "owner/name", got: ${JSON.stringify(raw)}`
    );
  }
  return { owner, repo };
}

/**
 * A human-readable one-line description of a scope, for `--print-config` and
 * watch poll lines (the caller appends provider-specific filters like `label:`).
 */
export function describeScope(scope: WorkScope): string {
  switch (scope.provider) {
    case "plan":
      return "plan (local workspace)";
    case "github":
      return scope.owner && scope.repo
        ? `github ${scope.owner}/${scope.repo}`
        : "github (default repo)";
    case "linear": {
      const bits: string[] = [];
      if (scope.team) bits.push(`team:${scope.team}`);
      if (scope.project) bits.push(`project:${scope.project}`);
      return bits.length ? `linear ${bits.join(" ")}` : "linear (default team)";
    }
  }
}
