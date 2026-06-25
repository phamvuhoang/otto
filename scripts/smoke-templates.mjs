// Render the real shipped templates and verify @spill paths, inlined sections,
// and that prompts stay small. Shell/`git` tags render against a tiny throwaway
// git fixture — NOT this repo — so the size budget measures each template's
// intrinsic footprint, not how verbose this repo's recent commit messages are
// (review.md/afk.md inline `git log -n 3 --format=%B`, which is unbounded).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { renderTemplate } from "../packages/core/dist/render.js";

const repo = process.cwd();
const tplDir = join(repo, "packages", "core", "templates");

// Deterministic git fixture: one tiny commit, so `git log`/`git show`/`git
// rev-parse` in the templates produce small, repeatable output.
const gitFixture = mkdtempSync(join(tmpdir(), "otto-smoke-git-"));
const git = (args) => execFileSync("git", args, { cwd: gitFixture });
git(["init", "-q"]);
git(["config", "user.email", "smoke@otto.test"]);
git(["config", "user.name", "smoke"]);
writeFileSync(join(gitFixture, "README.md"), "# smoke fixture\n");
git(["add", "."]);
git(["commit", "-q", "-m", "fixture commit"]);

const cases = [
  { name: "afk.md", inputs: "tracer bullet: hello world" },
  { name: "ghafk.md", inputs: "" },
  { name: "review.md", inputs: "" },
];

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) process.stdout.write(`ok    ${name}\n`);
  else {
    process.stdout.write(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}\n`);
    failures++;
  }
};

for (const { name, inputs } of cases) {
  const work = mkdtempSync(
    join(tmpdir(), `otto-smoke-${name.replace(".md", "")}-`)
  );
  const spillRel = `spill-test-${name}`;
  const spillHostDir = join(work, ".otto-tmp", spillRel);
  const spillRefPath = posix.join(".otto-tmp", spillRel);
  try {
    const out = renderTemplate(
      join(tplDir, name),
      { INPUTS: inputs },
      { cwd: gitFixture, spillHostDir, spillRefPath }
    );
    const tokensApprox = Math.round(out.length / 4);
    process.stdout.write(
      `---- ${name} : ${out.length} chars (~${tokensApprox} tok)\n`
    );
    check(
      `${name}: under 20k tokens`,
      tokensApprox < 20000,
      `~${tokensApprox} tok`
    );

    if (name === "ghafk.md") {
      check(`${name}: has <issues-summary>`, out.includes("<issues-summary>"));
      check(
        `${name}: spill path inlined`,
        out.includes(`./${spillRefPath}/issues.json`)
      );
      check(
        `${name}: spill file exists`,
        existsSync(join(spillHostDir, "issues.json"))
      );
    }
    if (name === "review.md") {
      check(
        `${name}: spill path inlined`,
        out.includes(`./${spillRefPath}/head.diff`)
      );
      check(
        `${name}: spill file exists`,
        existsSync(join(spillHostDir, "head.diff"))
      );
      check(`${name}: includes REVIEWER`, out.includes("# REVIEWER"));
    }
    if (name === "afk.md") {
      check(
        `${name}: INPUTS substituted`,
        out.includes("tracer bullet: hello world")
      );
    }
  } catch (e) {
    check(`${name}: render did not throw`, false, String(e));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

rmSync(gitFixture, { recursive: true, force: true });

if (failures) {
  process.stderr.write(`\n${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write("\nall pass\n");
