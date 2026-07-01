import { describe, expect, it, vi } from "vitest";

import { compressContent, compressContentSync } from "../context-compressor.js";
import {
  HEADROOM_VERSION,
  authorizeCompressor,
  createHeadroomCompressor,
  createHeadroomSyncCompressor,
  headroomToolDefinition,
  libraryHeadroomRunner,
  resolveHeadroomRunner,
  type HeadroomRunner,
} from "../headroom-adapter.js";
import { DEFAULT_POLICY } from "../safety-policy.js";
import type { ToolConfig } from "../tools.js";

function runner(over: Partial<HeadroomRunner> = {}): HeadroomRunner {
  return {
    available: () => true,
    run: (input) => ({ ok: true, text: input.text.slice(0, 5) }),
    ...over,
  };
}

// A fake spawnSync: returns a fixed SpawnSyncReturns-shaped object. Typed loosely
// because tests only read status/stdout/stderr/error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeSpawn(result: Record<string, unknown>): any {
  return vi.fn(() => result);
}

describe("createHeadroomCompressor", () => {
  it("exposes name/version and proxies the runner", async () => {
    const c = createHeadroomCompressor(runner());
    expect(c.name).toBe("headroom");
    expect(c.version).toBe(HEADROOM_VERSION);
    expect(await c.isAvailable()).toBe(true);
    const r = await c.compress({
      key: "k",
      category: "command-log",
      text: "abcdefgh",
    });
    expect(r).toEqual({ ok: true, text: "abcde" });
  });

  it("caches the availability probe (one --version per run)", async () => {
    const available = vi.fn(() => true);
    const c = createHeadroomCompressor(runner({ available }));
    await c.isAvailable();
    await c.isAvailable();
    expect(available).toHaveBeenCalledTimes(1);
  });

  it("an unavailable runner degrades through compressContent, never throws", async () => {
    const c = createHeadroomCompressor(runner({ available: () => false }));
    const out = await compressContent(
      c,
      { key: "k", category: "issue-body", text: "x".repeat(400) },
      null
    );
    expect(out.degraded).toBe(true);
    expect(out.text).toBe("x".repeat(400));
  });

  it("a runner failure (ok:false) degrades to the original", async () => {
    const c = createHeadroomCompressor(
      runner({ run: (i) => ({ ok: false, text: i.text, note: "exit 1" }) })
    );
    const out = await compressContent(
      c,
      { key: "k", category: "command-log", text: "y".repeat(400) },
      null
    );
    expect(out.degraded).toBe(true);
    expect(out.note).toBe("exit 1");
  });
});

describe("createHeadroomSyncCompressor", () => {
  it("probes availability once at construction and proxies the runner", () => {
    const c = createHeadroomSyncCompressor(runner());
    expect(c.name).toBe("headroom");
    expect(c.version).toBe(HEADROOM_VERSION);
    expect(c.available).toBe(true);
    expect(
      c.compress({ key: "k", category: "command-log", text: "abcdefgh" })
    ).toEqual({
      ok: true,
      text: "abcde",
    });
  });

  it("an unavailable runner yields available:false and degrades via compressContentSync", () => {
    const c = createHeadroomSyncCompressor(runner({ available: () => false }));
    expect(c.available).toBe(false);
    const out = compressContentSync(
      c,
      { key: "k", category: "issue-body", text: "x".repeat(400) },
      null
    );
    expect(out.degraded).toBe(true);
    expect(out.text).toBe("x".repeat(400));
  });
});

describe("libraryHeadroomRunner", () => {
  const input = {
    key: "k",
    category: "issue-body" as const,
    text: "verbose original text",
  };

  it("probes availability via `python3 -c import headroom`", () => {
    const spawn = fakeSpawn({ status: 0 });
    const r = libraryHeadroomRunner({}, 30_000, spawn);
    expect(r.available()).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "python3",
      ["-c", "import headroom"],
      expect.objectContaining({ timeout: 5_000 })
    );
  });

  it("available() is false on non-zero exit or a spawn throw", () => {
    expect(
      libraryHeadroomRunner({}, 30_000, fakeSpawn({ status: 1 })).available()
    ).toBe(false);
    const throwing = vi.fn(() => {
      throw new Error("no python");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    expect(libraryHeadroomRunner({}, 30_000, throwing).available()).toBe(false);
  });

  it("run() drives the bridge on stdin and returns compressed stdout", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "short" });
    const out = libraryHeadroomRunner({}, 30_000, spawn).run(input);
    expect(out).toEqual({ ok: true, text: "short" });
    const [bin, argv, opts] = spawn.mock.calls[0];
    expect(bin).toBe("python3");
    expect(argv[0]).toBe("-c");
    expect(argv[1]).toContain("from headroom import compress");
    // #192: opt the single user message INTO compression — Headroom's defaults
    // (compress_user_messages=False, protect_recent=4) would preserve it.
    expect(argv[1]).toContain("compress_user_messages=True");
    expect(argv[1]).toContain("protect_recent=0");
    expect(opts.input).toBe(input.text);
  });

  it("run() degrades (ok:false, original text) on failure, surfacing stderr", () => {
    const spawn = fakeSpawn({
      status: 1,
      stdout: "",
      stderr: "headroom compress failed: missing api key",
    });
    const out = libraryHeadroomRunner({}, 30_000, spawn).run(input);
    expect(out.ok).toBe(false);
    expect(out.text).toBe(input.text);
    expect(out.note).toContain("missing api key");
  });

  it("honors OTTO_HEADROOM_PYTHON", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "z" });
    libraryHeadroomRunner(
      { OTTO_HEADROOM_PYTHON: "py3.12" },
      30_000,
      spawn
    ).run(input);
    expect(spawn.mock.calls[0][0]).toBe("py3.12");
  });

  it("runs the bridge offline by default (no ungoverned HF download), respecting an explicit value", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "z" });
    libraryHeadroomRunner({}, 30_000, spawn).run(input);
    expect(spawn.mock.calls[0][2].env.HF_HUB_OFFLINE).toBe("1");

    const spawn2 = fakeSpawn({ status: 0, stdout: "z" });
    libraryHeadroomRunner({ HF_HUB_OFFLINE: "0" }, 30_000, spawn2).run(input);
    expect(spawn2.mock.calls[0][2].env.HF_HUB_OFFLINE).toBe("0");
  });

  it("forces HF_HUB_DISABLE_XET=1 so transfers stay on the declared hosts", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "z" });
    // Even if the caller tries to enable Xet, Otto forces it off.
    libraryHeadroomRunner({ HF_HUB_DISABLE_XET: "0" }, 30_000, spawn).run(
      input
    );
    expect(spawn.mock.calls[0][2].env.HF_HUB_DISABLE_XET).toBe("1");
  });
});

describe("resolveHeadroomRunner", () => {
  const input = { key: "k", category: "issue-body" as const, text: "t" };

  it("uses command mode when OTTO_HEADROOM_BIN is set", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "c" });
    resolveHeadroomRunner(
      { OTTO_HEADROOM_BIN: "/my/headroom" },
      30_000,
      spawn
    ).run(input);
    const [bin, argv] = spawn.mock.calls[0];
    expect(bin).toBe("/my/headroom");
    expect(argv).toEqual(["compress", "--category", "issue-body"]);
  });

  it("uses library mode (python bridge) when OTTO_HEADROOM_BIN is unset", () => {
    const spawn = fakeSpawn({ status: 0, stdout: "c" });
    resolveHeadroomRunner({}, 30_000, spawn).run(input);
    const [bin, argv] = spawn.mock.calls[0];
    expect(bin).toBe("python3");
    expect(argv[1]).toContain("from headroom import compress");
  });
});

describe("headroomToolDefinition", () => {
  it("is an opt-in, locally-scoped tool under the P19 contract", () => {
    const t = headroomToolDefinition();
    expect(t).toMatchObject({
      name: "headroom",
      kind: "command",
      enabled: true,
    });
    expect(t.stages).toEqual([]); // not stage-gated: compressor runs at render boundary
    expect(t.capabilities).toContain("compression");
    expect(t.env).toContain("HEADROOM_MODEL"); // selects the tokenizer (local, no key)
    // #192 part 3: health mirrors runtime env resolution, cross-platform — a
    // `node -e` probe (no POSIX shell builtins, so it works under cmd.exe too).
    expect(t.healthCheck).toContain("node -e");
    expect(t.healthCheck).toContain("OTTO_HEADROOM_BIN");
    expect(t.healthCheck).toContain("OTTO_HEADROOM_PYTHON");
    expect(t.healthCheck).toContain("import headroom");
    expect(t.healthCheck).not.toContain("if ["); // not POSIX-shell-only
  });
});

describe("authorizeCompressor (#192 part 2)", () => {
  const noConfig: ToolConfig = { overrides: {} };
  const noEnv = {}; // no OTTO_HEADROOM_BIN → library (python) command

  it("allows when no headroom tool is registered (config/flag-driven, unchanged)", () => {
    const a = authorizeCompressor([], noConfig, DEFAULT_POLICY, noEnv);
    expect(a.allowed).toBe(true);
    expect(a.events).toEqual([]);
  });

  it("allows a registered, enabled tool under default policy", () => {
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      DEFAULT_POLICY,
      noEnv
    );
    expect(a.allowed).toBe(true);
    expect(a.events).toEqual([]);
  });

  it("denies when the tool is disabled in the registry", () => {
    const tool = { ...headroomToolDefinition(), enabled: false };
    const a = authorizeCompressor([tool], noConfig, DEFAULT_POLICY, noEnv);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("disabled");
  });

  it("denies when a config override disables the tool", () => {
    const cfg: ToolConfig = { overrides: { headroom: { enabled: false } } };
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      cfg,
      DEFAULT_POLICY,
      noEnv
    );
    expect(a.allowed).toBe(false);
  });

  it("denies and emits events when policy blocks the library command", () => {
    const policy = { ...DEFAULT_POLICY, blockedCommands: ["headroom"] };
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      policy,
      noEnv
    );
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("blocked by policy");
    expect(a.events.length).toBeGreaterThan(0);
  });

  // The bug this closes: policy must authorize the command the run ACTUALLY
  // executes (resolved from env), not the static tool.command.
  it("denies an OTTO_HEADROOM_BIN that policy blocks (authorizes the resolved command)", () => {
    const policy = { ...DEFAULT_POLICY, blockedCommands: ["evil-compressor"] };
    const tool = headroomToolDefinition(); // static command is python, not evil
    const blocked = authorizeCompressor([tool], noConfig, policy, {
      OTTO_HEADROOM_BIN: "evil-compressor",
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.events.length).toBeGreaterThan(0);
    // Same policy, no override → the default library command is not blocked.
    const allowed = authorizeCompressor([tool], noConfig, policy, noEnv);
    expect(allowed.allowed).toBe(true);
  });

  // Authorization must see the full argv (`compress --category <c>`), not just
  // `<bin> compress` — else an argument-specific blocked pattern slips through.
  it("denies an argument-specific blocked pattern in command mode", () => {
    const policy = {
      ...DEFAULT_POLICY,
      blockedCommands: ["compress --category command-log"],
    };
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      policy,
      {
        OTTO_HEADROOM_BIN: "mybin",
      }
    );
    expect(a.allowed).toBe(false);
    expect(a.events.length).toBeGreaterThan(0);
  });

  // HF_HUB_OFFLINE=0 opts into the in-run Hugging Face download — which must then
  // be gated by the repo's network policy, not silently allowed.
  it("denies the in-run HF download when network policy excludes Hugging Face", () => {
    const policy = {
      ...DEFAULT_POLICY,
      allowedNetworkDomains: ["internal.example"],
    };
    const denied = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      policy,
      { HF_HUB_OFFLINE: "0" }
    );
    expect(denied.allowed).toBe(false);
    expect(denied.events.length).toBeGreaterThan(0);

    // Same restrictive policy but offline (the default) → no network, so allowed.
    const offline = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      policy,
      noEnv
    );
    expect(offline.allowed).toBe(true);
  });

  it("allows the in-run HF download under an unrestricted network policy", () => {
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      DEFAULT_POLICY,
      { HF_HUB_OFFLINE: "0" }
    );
    expect(a.allowed).toBe(true);
  });

  // HF reads HF_ENDPOINT directly, so authorization must check the RESOLVED host.
  it("denies a HF_ENDPOINT host that network policy excludes", () => {
    const policy = {
      ...DEFAULT_POLICY,
      allowedNetworkDomains: ["huggingface.co"],
    };
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      policy,
      {
        HF_HUB_OFFLINE: "0",
        HF_ENDPOINT: "https://evil.example",
      }
    );
    expect(a.allowed).toBe(false);
    expect(a.events.length).toBeGreaterThan(0);
  });

  // Even under an UNRESTRICTED repo policy, an HF_ENDPOINT outside the tool's
  // declared networkDomains must be denied — the registry scope, not just repo
  // policy, bounds the endpoint (a mirror must be added to the tool explicitly).
  it("denies an out-of-registry HF_ENDPOINT under DEFAULT_POLICY (tool scope holds)", () => {
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      DEFAULT_POLICY,
      { HF_HUB_OFFLINE: "0", HF_ENDPOINT: "https://evil.example" }
    );
    expect(a.allowed).toBe(false);
    expect(a.events.length).toBeGreaterThan(0);
  });

  // Otto's offline parsing must match HF's: only 1/true/yes/on are offline, so an
  // unrecognized value runs ONLINE and must be authorized (not silently skipped).
  it("treats an unrecognized HF_HUB_OFFLINE value as online (authorizes network)", () => {
    const policy = {
      ...DEFAULT_POLICY,
      allowedNetworkDomains: ["internal.example"],
    };
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      policy,
      {
        HF_HUB_OFFLINE: "maybe",
      }
    );
    expect(a.allowed).toBe(false);
  });

  // Command mode (custom OTTO_HEADROOM_BIN) bypasses the Python library, so the HF
  // network check must not apply — a restrictive network policy can't block it.
  it("skips the HF network check in command mode", () => {
    const policy = {
      ...DEFAULT_POLICY,
      allowedNetworkDomains: ["internal.example"],
    };
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      policy,
      {
        OTTO_HEADROOM_BIN: "mybin",
        HF_HUB_OFFLINE: "0",
      }
    );
    expect(a.allowed).toBe(true);
  });
});

// Real Headroom, no fake spawn — proves library mode actually compresses with the
// kwargs above. Gated behind OTTO_HEADROOM_E2E=1 (explicit opt-in) so the normal
// suite never triggers the ~600 MB model download even on a machine where
// `headroom-ai[ml]` is importable. Run it with:
//   OTTO_HEADROOM_E2E=1 pnpm --filter @phamvuhoang/otto-core test -- headroom-adapter
// Allows the one-time download (HF_HUB_OFFLINE=0) with a generous timeout, and uses
// a payload well above Headroom's ~250-token threshold.
describe("library mode end-to-end", () => {
  const optedIn = process.env.OTTO_HEADROOM_E2E === "1";
  const realRunner = libraryHeadroomRunner(
    { ...process.env, HF_HUB_OFFLINE: "0" },
    600_000
  );
  // Short-circuit so `available()` (which spawns python) doesn't run unless opted in.
  const maybe = optedIn && realRunner.available() ? it : it.skip;

  maybe(
    "reduces the payload on bulky, compressible content",
    () => {
      const text =
        "stale tool output: repeated filler line that headroom should shrink\n".repeat(
          300
        );
      const out = realRunner.run({ key: "e2e", category: "command-log", text });
      expect(out.ok).toBe(true);
      expect(out.text.length).toBeLessThan(text.length); // actual token savings
    },
    600_000
  );
});
