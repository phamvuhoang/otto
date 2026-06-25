import { describe, expect, it, vi } from "vitest";

import { compressContent, compressContentSync } from "../context-compressor.js";
import {
  HEADROOM_VERSION,
  createHeadroomCompressor,
  createHeadroomSyncCompressor,
  headroomToolDefinition,
  type HeadroomRunner,
} from "../headroom-adapter.js";

function runner(over: Partial<HeadroomRunner> = {}): HeadroomRunner {
  return {
    available: () => true,
    run: (input) => ({ ok: true, text: input.text.slice(0, 5) }),
    ...over,
  };
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

describe("headroomToolDefinition", () => {
  it("is an opt-in, locally-scoped command tool under the P19 contract", () => {
    const t = headroomToolDefinition();
    expect(t).toMatchObject({
      name: "headroom",
      kind: "command",
      enabled: true,
    });
    expect(t.stages).toEqual([]); // opt-in: a repo enables it per stage
    expect(t.networkDomains).toEqual([]); // local command mode: no network
    expect(t.capabilities).toContain("compression");
    expect(t.healthCheck).toBe("headroom --version");
  });
});
