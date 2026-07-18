// Release smoke: pack both workspace packages, install the tarballs into an
// isolated prefix (no global pollution), and verify the installed otto-afk bin
// prints usage and resolved config. This exercises the *published shape* — the
// CLI's workspace:^ core dep is rewritten to a concrete spec by `pnpm pack`, so
// a green run proves the installed @phamvuhoang/otto resolves a real
// @phamvuhoang/otto-core. See CONTRIBUTING.md / RELEASING.md.
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "otto-pack-install-"));
const packDir = join(work, "packs");
const installDir = join(work, "install");

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) process.stdout.write(`ok    ${name}\n`);
  else {
    process.stdout.write(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}\n`);
    failures++;
  }
};

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...opts });

// A Node `gh` shim (CommonJS — no nearby package.json to signal ESM, and the
// file must be named exactly `gh` for PATH resolution). Serves the three read
// calls otto-review's adapter makes for a one-shot text review (`api user`,
// an exact label lookup, `pr view`) from the caller-supplied fixture SHAs, and
// throws (nonzero exit) on any GitHub WRITE method (`-X POST`/`PATCH`/
// `DELETE`) — every invocation, read or write, is appended to `logPath` first
// so the caller can assert zero writes ever reached it.
function ghShimSource({ repo, label, pr, baseSha, headSha, logPath }) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const argv = process.argv.slice(2);
try {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");
} catch {}
const writeIdx = argv.findIndex(
  (a, i) => a === "-X" && ["POST", "PATCH", "DELETE"].includes(argv[i + 1])
);
if (writeIdx !== -1) {
  process.stderr.write(
    "otto-review smoke gh shim: refusing a GitHub WRITE call: " +
      JSON.stringify(argv) +
      "\\n"
  );
  process.exit(1);
}
if (argv[0] === "api" && argv[1] === "user") {
  process.stdout.write(JSON.stringify({ login: "otto-smoke-bot" }) + "\\n");
  process.exit(0);
}
if (argv[0] === "label" && argv[1] === "list") {
  const i = argv.indexOf("--search");
  const searched = i >= 0 ? argv[i + 1] : ${JSON.stringify(label)};
  process.stdout.write(JSON.stringify([{ name: searched }]) + "\\n");
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "view") {
  process.stdout.write(
    JSON.stringify({
      number: ${JSON.stringify(pr)},
      url: ${JSON.stringify(`https://github.com/${repo}/pull/${pr}`)},
      title: "otto-review smoke PR",
      body: "smoke test PR body",
      author: { login: "octocat" },
      state: "OPEN",
      isDraft: false,
      labels: [{ name: ${JSON.stringify(label)} }],
      baseRefName: "main",
      baseRefOid: ${JSON.stringify(baseSha)},
      headRefOid: ${JSON.stringify(headSha)},
      files: [{ path: "src/app.ts" }],
    }) + "\\n"
  );
  process.exit(0);
}
process.stderr.write(
  "otto-review smoke gh shim: unexpected invocation: " +
    JSON.stringify(argv) +
    "\\n"
);
process.exit(1);
`;
}

// A Node `claude` shim: reads the rendered-prompt path out of the fixed
// "Read the full instructions from the file ./<path> ..." trailing argv
// element, then emits one valid stream-json `result` event whose text is
// `<lens>SKIP</lens>` — a clean lens (no `|`-delimited finding rows), so the
// panel's merge step sees zero candidate findings and never invokes the
// verifier at all. Every stage (all 5 lenses; verify is never reached) gets
// the identical response.
function claudeShimSource() {
  return `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const last = argv[argv.length - 1] || "";
const m = last.match(/\\.\\/(\\S+\\.md)/);
if (m) {
  try {
    readFileSync(m[1], "utf8");
  } catch {}
}
process.stdout.write(
  JSON.stringify({
    type: "result",
    result: "<lens>SKIP</lens>",
    total_cost_usd: 0,
    is_error: false,
  }) + "\\n"
);
process.exit(0);
`;
}

try {
  // 1. Build core — the tarball ships dist/, which `pnpm pack` does not rebuild.
  process.stdout.write("---- building core\n");
  run("pnpm", ["-r", "build"], { cwd: repo, stdio: "inherit" });

  // 2. Pack both packages into an isolated dir (version-agnostic globs below).
  process.stdout.write("---- packing tarballs\n");
  run("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: join(repo, "packages", "core"),
  });
  run("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: join(repo, "apps", "cli"),
  });

  const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
  const coreTgz = tarballs.find((f) => f.includes("otto-core"));
  const cliTgz = tarballs.find((f) => !f.includes("otto-core"));
  check("packed otto-core tarball", Boolean(coreTgz), tarballs.join(", "));
  check("packed otto cli tarball", Boolean(cliTgz), tarballs.join(", "));
  if (!coreTgz || !cliTgz) throw new Error("missing tarball(s)");

  // 3. Install both tarballs into an isolated prefix. Offline: the CLI's only
  //    dependency is the core tarball we provide alongside it, so no registry
  //    access is needed. --no-save keeps the throwaway prefix manifest-free; a
  //    per-run --cache keeps the install hermetic (no shared ~/.npm).
  process.stdout.write("---- installing into isolated prefix\n");
  run(
    "npm",
    [
      "install",
      "--prefix",
      installDir,
      "--cache",
      join(work, "npm-cache"),
      "--offline",
      "--no-audit",
      "--no-fund",
      "--no-save",
      join(packDir, coreTgz),
      join(packDir, cliTgz),
    ],
    { cwd: work, stdio: "inherit" }
  );

  // Invoke the installed entry with node (cross-platform; .bin shims differ by
  // OS). Running from installDir forces @phamvuhoang/otto-core to resolve from
  // the installed node_modules — the published-shape check.
  const entry = join(
    installDir,
    "node_modules",
    "@phamvuhoang",
    "otto",
    "bin",
    "otto-afk.js"
  );
  const invoke = (args) =>
    run(process.execPath, [entry, ...args], { cwd: installDir });

  // 4a. Usage — `--help` prints the usage block to stdout and exits 0.
  const help = invoke(["--help"]);
  check("--help prints usage", help.includes("Usage:"), help.slice(0, 200));
  check("--help names the bin", help.includes("otto-afk"));

  // 4b. Run config — `--print-config` prints the resolved-config + preflight
  //     blocks to stdout and exits 0.
  const cfg = invoke(["--print-config"]);
  check(
    "--print-config prints resolved config",
    cfg.includes("[otto-afk] resolved config"),
    cfg.slice(0, 200)
  );
  check(
    "--print-config prints preflight",
    cfg.includes("[otto-afk] preflight")
  );

  // ---------------------------------------------------------------------
  // P32 otto-review smoke: --help, --print-config (local-only, no live
  // GitHub/model call), and one full installed one-shot text review with
  // zero network (a local bare origin + a `gh`/`claude` Node shim pair).
  // ---------------------------------------------------------------------
  process.stdout.write("---- otto-review smoke\n");

  const reviewEntry = join(
    installDir,
    "node_modules",
    "@phamvuhoang",
    "otto",
    "bin",
    "otto-review.js"
  );
  const invokeReview = (args, opts = {}) =>
    run(process.execPath, [reviewEntry, ...args], {
      cwd: opts.cwd ?? installDir,
      env: { ...process.env, ...(opts.env ?? {}) },
    });

  // 4c. --help.
  const reviewHelp = invokeReview(["--help"]);
  check(
    "otto-review --help prints usage",
    reviewHelp.includes("Usage:") && reviewHelp.includes("otto-review"),
    reviewHelp.slice(0, 200)
  );

  // 4d. --print-config: local probes only — no live GitHub/model call. The
  //     prompt is redacted to its length and the remote label/issue checks
  //     are reported as deferred until a real run.
  const reviewPromptText = "do not echo this review intent";
  const reviewConfig = invokeReview([
    "--repo",
    "acme/web",
    "--watch",
    "--prompt",
    reviewPromptText,
    "--print-config",
  ]);
  check(
    "otto-review --print-config redacts the prompt to `direct (<N> chars)`",
    reviewConfig.includes(`direct (${reviewPromptText.length} chars)`),
    reviewConfig
  );
  check(
    "otto-review --print-config never echoes the prompt body",
    !reviewConfig.includes(reviewPromptText),
    reviewConfig
  );
  check(
    "otto-review --print-config defers the remote label/issue checks",
    reviewConfig.includes("deferred"),
    reviewConfig
  );

  // 4e. One full installed one-shot text review, zero network: a local bare
  //     origin + target checkout with base/head commits and
  //     `refs/pull/1/head`, `gh`/`claude` Node shims first on PATH, and
  //     temporary `~/.config/gh` / `~/.claude` preflight markers.
  process.stdout.write("---- otto-review one-shot smoke (offline)\n");
  const reviewWork = mkdtempSync(join(tmpdir(), "otto-review-smoke-"));
  try {
    const bareOrigin = join(reviewWork, "origin.git");
    run("git", ["init", "--bare", "-q", bareOrigin]);

    const seed = join(reviewWork, "seed");
    mkdirSync(seed, { recursive: true });
    const gitSeed = (...args) => run("git", args, { cwd: seed });
    gitSeed("init", "-q");
    gitSeed("symbolic-ref", "HEAD", "refs/heads/main");
    gitSeed("config", "user.email", "smoke@otto.test");
    gitSeed("config", "user.name", "smoke");
    mkdirSync(join(seed, "src"), { recursive: true });
    writeFileSync(join(seed, "src", "app.ts"), "export const v = 1;\n");
    gitSeed("add", ".");
    gitSeed("commit", "-qm", "base");
    const baseSha = run("git", ["rev-parse", "HEAD"], { cwd: seed }).trim();
    gitSeed("remote", "add", "origin", bareOrigin);
    gitSeed("push", "-q", "origin", "HEAD:refs/heads/main");
    writeFileSync(join(seed, "src", "app.ts"), "export const v = 2;\n");
    gitSeed("add", ".");
    gitSeed("commit", "-qm", "head");
    const headSha = run("git", ["rev-parse", "HEAD"], { cwd: seed }).trim();
    gitSeed("push", "-q", "origin", "HEAD:refs/pull/1/head");
    run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
      cwd: bareOrigin,
    });

    const target = join(reviewWork, "target");
    run("git", ["clone", "-q", bareOrigin, target]);
    const gitTarget = (...args) => run("git", args, { cwd: target });
    gitTarget("config", "user.email", "smoke@otto.test");
    gitTarget("config", "user.name", "smoke");
    // The review preflight's origin check requires `git remote get-url
    // origin` to resolve to a literal github.com/<owner>/<repo> remote
    // (`canonicalGithubOrigin` — an `insteadOf` rewrite would make `get-url`
    // itself report the REWRITTEN target, defeating the point). So the origin
    // is a real scp-style GitHub SSH remote, and `GIT_SSH_COMMAND` (below)
    // points every `ssh` git would spawn at a Node shim that ignores the
    // real host/command and always serves `git upload-pack` against the
    // local bare fixture instead — `git fetch` resolves fully offline while
    // the configured remote URL is genuinely `git@github.com:acme/web.git`.
    gitTarget("remote", "set-url", "origin", "git@github.com:acme/web.git");

    const sshShimPath = join(reviewWork, "fake-ssh.js");
    writeFileSync(
      sshShimPath,
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const r = spawnSync("git", ["upload-pack", ${JSON.stringify(bareOrigin)}], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
`
    );
    chmodSync(sshShimPath, 0o755);

    const shimDir = join(reviewWork, "shims");
    mkdirSync(shimDir, { recursive: true });
    const ghLog = join(reviewWork, "gh-calls.jsonl");
    writeFileSync(
      join(shimDir, "gh"),
      ghShimSource({
        repo: "acme/web",
        label: "otto-review",
        pr: 1,
        baseSha,
        headSha,
        logPath: ghLog,
      })
    );
    chmodSync(join(shimDir, "gh"), 0o755);
    writeFileSync(join(shimDir, "claude"), claudeShimSource());
    chmodSync(join(shimDir, "claude"), 0o755);

    const homeDir = join(reviewWork, "home");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    mkdirSync(join(homeDir, ".config", "gh"), { recursive: true });

    const reviewPrompt = "check retry cancellation";
    const reviewEnv = {
      PATH: `${shimDir}${delimiter}${process.env.PATH}`,
      HOME: homeDir,
      OTTO_WORKSPACE: target,
      GIT_SSH_COMMAND: sshShimPath,
    };
    const oneShotOut = invokeReview(
      [
        "--repo",
        "acme/web",
        "--pr",
        "1",
        "--prompt",
        reviewPrompt,
        "--output",
        "text",
      ],
      { cwd: target, env: reviewEnv }
    );
    check(
      "otto-review one-shot exits 0 with an approved terminal verdict",
      oneShotOut.includes("Outcome: Approved"),
      oneShotOut
    );

    const runIdMatch = oneShotOut.match(/Run ID: (\S+)/);
    check(
      "otto-review one-shot text output names its Run ID",
      Boolean(runIdMatch),
      oneShotOut
    );
    const runId = runIdMatch ? runIdMatch[1] : null;
    if (runId) {
      const runDir = join(target, ".otto", "runs", runId);
      const reviewMdPath = join(runDir, "review.md");
      const reviewMd = existsSync(reviewMdPath)
        ? readFileSync(reviewMdPath, "utf8")
        : "";
      check(
        "canonical review.md written to the run bundle",
        reviewMd.includes("# Otto PR code review")
      );
      check(
        "review.md carries the summary + head markers",
        reviewMd.includes("<!-- otto-review:acme/web#1 -->") &&
          reviewMd.includes(`<!-- otto-review-head:${headSha} -->`),
        reviewMd
      );

      const diffPath = join(runDir, "pr.diff");
      check("exact diff artifact present", existsSync(diffPath));
      const diffText = existsSync(diffPath)
        ? readFileSync(diffPath, "utf8")
        : "";
      check(
        "diff artifact covers the changed file",
        diffText.includes("src/app.ts")
      );

      const inputPath = join(runDir, "review-input.md");
      check("exact review-input artifact present", existsSync(inputPath));
      const inputText = existsSync(inputPath)
        ? readFileSync(inputPath, "utf8")
        : "";
      // Same formula as reviewInputFingerprint (pr-review-input.ts):
      // sha256(kind \0 source \0 content).
      const expectedFingerprint = createHash("sha256")
        .update("prompt", "utf8")
        .update("\0", "utf8")
        .update("direct", "utf8")
        .update("\0", "utf8")
        .update(reviewPrompt, "utf8")
        .digest("hex");
      check(
        "review-input artifact matches the expected prompt fingerprint",
        inputText.includes(reviewPrompt) &&
          inputText.includes(`Fingerprint: ${expectedFingerprint}`),
        inputText
      );
      check(
        "review.md carries the expected composite input-fingerprint marker",
        reviewMd.includes(`<!-- otto-review-input:${expectedFingerprint} -->`)
      );
    }

    const ghCalls = existsSync(ghLog)
      ? readFileSync(ghLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const writeCalls = ghCalls.filter((argv) =>
      argv.some(
        (a, i) =>
          a === "-X" && ["POST", "PATCH", "DELETE"].includes(argv[i + 1])
      )
    );
    check(
      "zero GitHub write invocations recorded by the gh shim",
      writeCalls.length === 0,
      JSON.stringify(writeCalls)
    );
  } finally {
    rmSync(reviewWork, { recursive: true, force: true });
  }
} catch (e) {
  check("smoke ran without throwing", false, String(e?.stack ?? e));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures) {
  process.stderr.write(`\n${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write("\nall pass\n");
