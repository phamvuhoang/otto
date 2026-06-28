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
    expect(t.env).toContain("HEADROOM_MODEL"); // model-backed library mode
    // #192 part 3: health mirrors runtime env resolution (both override vars).
    expect(t.healthCheck).toContain("$OTTO_HEADROOM_BIN");
    expect(t.healthCheck).toContain("OTTO_HEADROOM_PYTHON");
    expect(t.healthCheck).toContain("import headroom");
  });
});

describe("authorizeCompressor (#192 part 2)", () => {
  const noConfig: ToolConfig = { overrides: {} };

  it("allows when no headroom tool is registered (config/flag-driven, unchanged)", () => {
    const a = authorizeCompressor([], noConfig, DEFAULT_POLICY);
    expect(a.allowed).toBe(true);
    expect(a.events).toEqual([]);
  });

  it("allows a registered, enabled tool under default policy", () => {
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      noConfig,
      DEFAULT_POLICY
    );
    expect(a.allowed).toBe(true);
    expect(a.events).toEqual([]);
  });

  it("denies when the tool is disabled in the registry", () => {
    const tool = { ...headroomToolDefinition(), enabled: false };
    const a = authorizeCompressor([tool], noConfig, DEFAULT_POLICY);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("disabled");
  });

  it("denies when a config override disables the tool", () => {
    const cfg: ToolConfig = { overrides: { headroom: { enabled: false } } };
    const a = authorizeCompressor(
      [headroomToolDefinition()],
      cfg,
      DEFAULT_POLICY
    );
    expect(a.allowed).toBe(false);
  });

  it("denies and emits events when policy blocks the tool command", () => {
    const policy = { ...DEFAULT_POLICY, blockedCommands: ["headroom"] };
    const a = authorizeCompressor([headroomToolDefinition()], noConfig, policy);
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain("blocked by policy");
    expect(a.events.length).toBeGreaterThan(0);
  });
});
