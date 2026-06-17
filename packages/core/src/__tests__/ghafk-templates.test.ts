import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Render-contract tests for the GitHub AFK templates. They pin the watch-scope
// threading (issue #21 P1) and the SECURITY INVARIANT from render.ts: runtime
// data ({{ INPUTS }}) never reaches a host shell command body, and the only env
// vars a shell/spill tag may reference are the two run-bin VALIDATES before
// exporting — $OTTO_ISSUE (parseIssueRef → positive int) and $OTTO_GITHUB_REPO
// (parseGithubRepo → shell-safe owner/name). Both admit only [A-Za-z0-9._/-].

const tpl = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}`, import.meta.url));

// Mirror render.ts's tag regexes to pull out command bodies that hit the shell.
const SHELL_TRY = /!\?`([^`]+)`/g;
const SHELL = /!`([^`]+)`/g;
const SPILL = /@spill\??:[^\s=]+=`([^`]+)`/g;

function shellCommandBodies(text: string): string[] {
  const bodies: string[] = [];
  for (const re of [SHELL_TRY, SHELL, SPILL]) {
    for (const m of text.matchAll(re)) bodies.push(m[1]);
  }
  return bodies;
}

const GH_TEMPLATES = ["ghafk.md", "ghafk-issue.md"];
// The exact shell fragment that confines a gh command to the scoped repo only
// when OTTO_GITHUB_REPO is set (empty/unset → the workspace's default repo).
const SCOPE_FRAGMENT = '${OTTO_GITHUB_REPO:+--repo "$OTTO_GITHUB_REPO"}';

describe("GitHub AFK templates — watch scope", () => {
  it("confine every `gh issue` shell command to OTTO_GITHUB_REPO when set", () => {
    for (const name of GH_TEMPLATES) {
      const raw = readFileSync(tpl(name), "utf8");
      const ghBodies = shellCommandBodies(raw).filter((b) =>
        /\bgh issue\b/.test(b)
      );
      // Sanity: each template really does drive at least one gh issue command.
      expect(ghBodies.length).toBeGreaterThan(0);
      for (const body of ghBodies) {
        expect(body).toContain(SCOPE_FRAGMENT);
      }
    }
  });

  it("keep the scope opt-in: the only `--repo` in a shell tag is the guarded one", () => {
    // ${VAR:+...} expands to nothing when OTTO_GITHUB_REPO is unset/empty, so the
    // default (workspace repo) behavior is preserved. Assert every `--repo` in a
    // shell command body lives inside the guard — never an unconditional flag
    // that would become `--repo ""` and fail when no scope is set.
    for (const name of GH_TEMPLATES) {
      const raw = readFileSync(tpl(name), "utf8");
      for (const body of shellCommandBodies(raw)) {
        const withoutGuarded = body.split(SCOPE_FRAGMENT).join("");
        expect(withoutGuarded).not.toContain("--repo");
      }
    }
  });
});

describe("GitHub AFK templates — security invariant", () => {
  it("never interpolate a template var into a host shell command (RCE invariant)", () => {
    for (const name of GH_TEMPLATES) {
      const raw = readFileSync(tpl(name), "utf8");
      for (const body of shellCommandBodies(raw)) {
        expect(body).not.toMatch(/\{\{/);
      }
    }
  });

  it("only reference the validated $OTTO_ISSUE / $OTTO_GITHUB_REPO env vars in shell tags", () => {
    const allowed = new Set(["$OTTO_ISSUE", "$OTTO_GITHUB_REPO"]);
    for (const name of GH_TEMPLATES) {
      const raw = readFileSync(tpl(name), "utf8");
      for (const body of shellCommandBodies(raw)) {
        const envRefs = body.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
        for (const ref of envRefs) {
          expect(allowed.has(ref)).toBe(true);
        }
      }
    }
  });
});
