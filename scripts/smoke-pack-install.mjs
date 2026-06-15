// Release smoke: pack both workspace packages, install the tarballs into an
// isolated prefix (no global pollution), and verify the installed otto-afk bin
// prints usage and resolved config. This exercises the *published shape* — the
// CLI's workspace:^ core dep is rewritten to a concrete spec by `pnpm pack`, so
// a green run proves the installed @phamvuhoang/otto resolves a real
// @phamvuhoang/otto-core. See CONTRIBUTING.md / RELEASING.md.
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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
  check("--print-config prints preflight", cfg.includes("[otto-afk] preflight"));
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
