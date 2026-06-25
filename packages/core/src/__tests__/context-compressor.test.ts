import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compressContent,
  compressContentSync,
  compressionToolUsage,
  readCompressorMode,
  resolveCompressorMode,
  runRetrievalStore,
  summarizeCompression,
  summarizeToolCompression,
  type CompressInput,
  type ContextCompressor,
  type RetrievalStore,
  type SyncContextCompressor,
} from "../context-compressor.js";
import { estimateTokens } from "../context-report.js";
import { applyPromptReduction } from "../prompt-reduction.js";

/** A fake compressor: configurable availability, transform, and ok flag. */
function fake(opts: {
  available?: boolean;
  ok?: boolean;
  transform?: (t: string) => string;
  throws?: boolean;
}): ContextCompressor {
  return {
    name: "headroom",
    version: "test-1",
    isAvailable: () => opts.available ?? true,
    compress: (input) => {
      if (opts.throws) return Promise.reject(new Error("boom"));
      return Promise.resolve({
        text: (opts.transform ?? ((t) => t))(input.text),
        ok: opts.ok ?? true,
      });
    },
  };
}

function input(text: string, key = "k1"): CompressInput {
  return { key, category: "command-log", text };
}

/** In-memory store capturing originals so tests can assert reversibility. */
function memStore(): { store: RetrievalStore; saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    store: (key, original) => {
      saved.set(key, original);
      return `handle:${key}`;
    },
  };
}

describe("resolveCompressorMode", () => {
  it("defaults to off and honors flag > env > config precedence", () => {
    expect(resolveCompressorMode({})).toBe("off");
    expect(resolveCompressorMode({ config: "headroom" })).toBe("headroom");
    expect(resolveCompressorMode({ env: "headroom", config: "off" })).toBe(
      "headroom"
    );
    expect(resolveCompressorMode({ flag: "off", env: "headroom" })).toBe("off");
  });

  it("maps unrecognized values to off (a typo never enables compression)", () => {
    expect(resolveCompressorMode({ flag: "headrm" })).toBe("off");
  });
});

describe("readCompressorMode", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "otto-comp-"));
    mkdirSync(join(work, ".otto"), { recursive: true });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("reads .otto/config.json contextCompressor, env overrides it", () => {
    writeFileSync(
      join(work, ".otto", "config.json"),
      JSON.stringify({
        contextCompressor: "headroom",
        journal: { enabled: true },
      })
    );
    expect(readCompressorMode(work, {})).toBe("headroom");
    expect(readCompressorMode(work, { OTTO_CONTEXT_COMPRESSOR: "off" })).toBe(
      "off"
    );
  });

  it("absent/malformed config → off (never throws)", () => {
    expect(readCompressorMode(work, {})).toBe("off");
    writeFileSync(join(work, ".otto", "config.json"), "{ broken");
    expect(readCompressorMode(work, {})).toBe("off");
  });
});

describe("compressContent", () => {
  it("off (null compressor) returns the original verbatim, no savings, not degraded", async () => {
    const out = await compressContent(null, input("hello world"), null);
    expect(out.text).toBe("hello world");
    expect(out.tokensSaved).toBe(0);
    expect(out.degraded).toBe(false);
    expect(out.retrievalHandle).toBeUndefined();
  });

  it("unavailable compressor degrades to the original with a note", async () => {
    const { store, saved } = memStore();
    const out = await compressContent(
      fake({ available: false }),
      input("x".repeat(400)),
      store
    );
    expect(out.degraded).toBe(true);
    expect(out.text).toBe("x".repeat(400));
    expect(out.note).toMatch(/unavailable/);
    expect(saved.size).toBe(0);
  });

  it("a thrown compressor error degrades, never throws", async () => {
    const out = await compressContent(
      fake({ throws: true }),
      input("y".repeat(400)),
      null
    );
    expect(out.degraded).toBe(true);
    expect(out.note).toMatch(/error/);
  });

  it("successful compression measures savings, stores the original, and is reversible", async () => {
    const { store, saved } = memStore();
    const original = "KEEP-THIS-FACT " + "filler ".repeat(200);
    const out = await compressContent(
      fake({ transform: () => "summary only" }),
      input(original),
      store,
      {
        now: (() => {
          let t = 0;
          return () => (t += 5);
        })(),
      }
    );
    expect(out.degraded).toBe(false);
    expect(out.text).toBe("summary only");
    expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
    expect(out.tokensSaved).toBe(out.tokensBefore - out.tokensAfter);
    expect(out.retrievalHandle).toBe("handle:k1");
    expect(out.latencyMs).toBe(5);
    // Reversibility: the original (with the buried fact) is retained verbatim.
    expect(saved.get("k1")).toBe(original);
    expect(saved.get("k1")).toContain("KEEP-THIS-FACT");
  });

  it("keeps the original when 'compression' did not reduce tokens", async () => {
    const { store, saved } = memStore();
    const out = await compressContent(
      fake({ transform: (t) => t + " even longer now" }),
      input("short text"),
      store
    );
    expect(out.text).toBe("short text");
    expect(out.tokensSaved).toBe(0);
    expect(saved.size).toBe(0);
  });
});

describe("Task 5 fixtures: buried fact / error signature / line-level evidence survive", () => {
  // A compressor that aggressively summarizes — the kind of lossy transform that
  // would lose a buried fact unless the original is retained.
  const summarizer = fake({
    transform: (t) => t.split("\n")[0] + "\n…(compressed)…",
  });

  async function roundTrip(category: CompressInput["category"], text: string) {
    const { store, saved } = memStore();
    const out = await compressContent(
      summarizer,
      { key: category, category, text },
      store
    );
    return { out, original: saved.get(category) };
  }

  it("buried fact in a large issue dump remains retrievable", async () => {
    const dump =
      "Issue: flaky checkout\n" +
      "noise\n".repeat(500) +
      "ROOT-CAUSE: race in cart mutex\n" +
      "noise\n".repeat(500);
    const { out, original } = await roundTrip("issue-body", dump);
    expect(out.text).not.toContain("ROOT-CAUSE"); // compressed dropped it
    expect(original).toContain("ROOT-CAUSE: race in cart mutex"); // original kept it
  });

  it("error signature in a large log survives in the retained original", async () => {
    const log =
      "build start\n" +
      "info line\n".repeat(800) +
      "TypeError: cannot read 'id' of undefined at app.ts:42\n";
    const { original } = await roundTrip("command-log", log);
    expect(original).toContain(
      "TypeError: cannot read 'id' of undefined at app.ts:42"
    );
  });

  it("line-level source evidence stays byte-exact in the original", async () => {
    const src = Array.from(
      { length: 300 },
      (_, i) => `line ${i}: code();`
    ).join("\n");
    const { original } = await roundTrip("read-artifact", src);
    expect(original).toBe(src);
  });
});

describe("summaries + tool usage", () => {
  it("summarizeCompression aggregates tokens, retrievals, and degraded counts", async () => {
    const { store } = memStore();
    const a = await compressContent(
      fake({ transform: () => "tiny" }),
      input("z".repeat(800), "a"),
      store
    );
    const b = await compressContent(
      fake({ available: false }),
      input("z".repeat(800), "b"),
      store
    );
    const s = summarizeCompression([a, b]);
    expect(s.invocations).toBe(2);
    expect(s.retrievals).toBe(1);
    expect(s.degraded).toBe(1);
    expect(s.tokensSaved).toBe(a.tokensSaved);
  });

  it("compressionToolUsage builds an evidence record; summarizeToolCompression reads it", async () => {
    const { store } = memStore();
    const out = await compressContent(
      fake({ transform: () => "tiny" }),
      input("q".repeat(800)),
      store
    );
    const usage = compressionToolUsage(out, "command-log", "review");
    expect(usage).toMatchObject({
      name: "headroom",
      kind: "command",
      stage: "review",
    });
    expect(usage.tokensSaved).toBe(out.tokensSaved);
    const rolled = summarizeToolCompression([
      usage,
      { name: "other", kind: "command" },
    ]);
    expect(rolled.invocations).toBe(1);
    expect(rolled.retrievals).toBe(1);
    expect(rolled.tokensSaved).toBe(out.tokensSaved);
  });
});

describe("compressContentSync (the render/@spill path)", () => {
  function syncFake(opts: {
    available?: boolean;
    transform?: (t: string) => string;
    throws?: boolean;
  }): SyncContextCompressor {
    return {
      name: "headroom",
      version: "sync-1",
      available: opts.available ?? true,
      compress: (i) => {
        if (opts.throws) throw new Error("boom");
        return { ok: true, text: (opts.transform ?? ((t) => t))(i.text) };
      },
    };
  }

  it("off (null) returns the original verbatim", () => {
    const out = compressContentSync(null, input("hi"), null);
    expect(out.text).toBe("hi");
    expect(out.degraded).toBe(false);
  });

  it("unavailable degrades to the original", () => {
    const out = compressContentSync(
      syncFake({ available: false }),
      input("x".repeat(400)),
      null
    );
    expect(out.degraded).toBe(true);
    expect(out.text).toBe("x".repeat(400));
  });

  it("a thrown sync compressor degrades, never throws", () => {
    const out = compressContentSync(
      syncFake({ throws: true }),
      input("y".repeat(400)),
      null
    );
    expect(out.degraded).toBe(true);
  });

  it("success stores the original and is reversible", () => {
    const { store, saved } = memStore();
    const original = "FACT-XYZ " + "pad ".repeat(200);
    const out = compressContentSync(
      syncFake({ transform: () => "small" }),
      input(original),
      store
    );
    expect(out.text).toBe("small");
    expect(out.tokensSaved).toBeGreaterThan(0);
    expect(saved.get("k1")).toBe(original);
  });
});

describe("Task 5 benchmark: off vs reduce vs headroom (no fact lost)", () => {
  // A large issue-dump fixture with one buried fact.
  const fixture =
    "Issue: checkout fails\n" +
    "log line that repeats a lot   \n".repeat(400) +
    "DECISIVE-FACT: the mutex is reentrant\n" +
    "more   trailing   noise\n".repeat(400);

  it("headroom cuts the most tokens while keeping the fact retrievable", () => {
    const off = estimateTokens(fixture.length);
    const reduce = estimateTokens(applyPromptReduction(fixture).prompt.length);

    const { store, saved } = memStore();
    const headroom = compressContentSync(
      {
        name: "headroom",
        version: "bench-1",
        available: true,
        // Summarize to the first + decisive lines — the kind of lossy transform
        // that must keep the original retrievable.
        compress: (i) => ({
          ok: true,
          text: i.text
            .split("\n")
            .filter(
              (l) => l.startsWith("Issue:") || l.startsWith("DECISIVE-FACT:")
            )
            .join("\n"),
        }),
      },
      { key: "bench", category: "issue-body", text: fixture },
      store
    );

    // off ≥ reduce (whitespace only) ≥ ... ; headroom is the smallest by far.
    expect(reduce).toBeLessThanOrEqual(off);
    expect(headroom.tokensAfter).toBeLessThan(reduce);
    expect(headroom.tokensSaved).toBeGreaterThan(off / 2);
    // No regression on the decisive fact: it survives in the retained original.
    expect(saved.get("bench")).toContain(
      "DECISIVE-FACT: the mutex is reentrant"
    );
  });
});

describe("runRetrievalStore (fs)", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "otto-comp-fs-"));
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("writes the original under the run bundle and returns a workspace-relative handle", () => {
    const store = runRetrievalStore(work, "run-1");
    const handle = store("issue-body/weird key", "the original content");
    expect(handle).toBe(
      join(".otto", "runs", "run-1", "compressed", "issue-body-weird-key.orig")
    );
    expect(readFileSync(join(work, handle), "utf8")).toBe(
      "the original content"
    );
  });
});
