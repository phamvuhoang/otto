import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import {
  createStdioCbmRunner,
  tokenizeCommand,
} from "../codebase-memory-adapter.js";

const mockSpawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

const reply = (obj: unknown) => ({
  status: 0,
  stdout: Buffer.from(JSON.stringify(obj) + "\n"),
  stderr: Buffer.from(""),
});

beforeEach(() => mockSpawn.mockReset());

describe("tokenizeCommand", () => {
  it("splits a plain command on whitespace", () => {
    expect(tokenizeCommand("node server.js --flag")).toEqual([
      "node",
      "server.js",
      "--flag",
    ]);
  });
  it("keeps a double-quoted spaced path as one token (regression)", () => {
    expect(tokenizeCommand('"/opt/My Tools/cbm" serve')).toEqual([
      "/opt/My Tools/cbm",
      "serve",
    ]);
  });
  it("keeps a single-quoted spaced path as one token", () => {
    expect(tokenizeCommand("'/opt/My Tools/cbm' --port 9")).toEqual([
      "/opt/My Tools/cbm",
      "--port",
      "9",
    ]);
  });
  it("collapses extra whitespace and returns [] for blank input", () => {
    expect(tokenizeCommand("  a   b ")).toEqual(["a", "b"]);
    expect(tokenizeCommand("   ")).toEqual([]);
  });
});

describe("createStdioCbmRunner spawns the tokenized binary", () => {
  it("invokes the quoted spaced binary path, not a shredded first word", () => {
    mockSpawn.mockReturnValue(reply({ jsonrpc: "2.0", id: 2, result: {} }));
    createStdioCbmRunner('"/opt/My Tools/cbm" serve', "/tmp", 1000).call({
      operation: "get_architecture",
      params: {},
    });
    // First positional arg to spawnSync is the resolved binary path.
    expect(mockSpawn.mock.calls[0][0]).toBe("/opt/My Tools/cbm");
    expect(mockSpawn.mock.calls[0][1]).toEqual(["serve"]);
  });
});

describe("createStdioCbmRunner.call parsing", () => {
  it("returns ok for a valid falsy result (regression: result:false)", () => {
    mockSpawn.mockReturnValue(reply({ jsonrpc: "2.0", id: 2, result: false }));
    const r = createStdioCbmRunner("cbm", "/tmp", 1000).call({
      operation: "index_status",
      params: {},
    });
    expect(r).toEqual({ ok: true, result: false });
  });

  it("returns ok for result:null", () => {
    mockSpawn.mockReturnValue(reply({ jsonrpc: "2.0", id: 2, result: null }));
    expect(
      createStdioCbmRunner("cbm", "/tmp", 1000).call({
        operation: "detect_changes",
        params: {},
      })
    ).toEqual({ ok: true, result: null });
  });

  it("surfaces a JSON-RPC error", () => {
    mockSpawn.mockReturnValue(
      reply({ jsonrpc: "2.0", id: 2, error: { message: "boom" } })
    );
    expect(
      createStdioCbmRunner("cbm", "/tmp", 1000).call({
        operation: "search_graph",
        params: {},
      })
    ).toEqual({ ok: false, error: "boom" });
  });

  it("ignores non-JSON banner lines and reports no-response when id:2 absent", () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: Buffer.from(
        "starting up...\n" +
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) +
          "\n"
      ),
      stderr: Buffer.from(""),
    });
    expect(
      createStdioCbmRunner("cbm", "/tmp", 1000).call({
        operation: "search_graph",
        params: {},
      })
    ).toEqual({ ok: false, error: "no response for tools/call" });
  });

  it("reports child failure when status != 0", () => {
    mockSpawn.mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("crashed"),
    });
    const r = createStdioCbmRunner("cbm", "/tmp", 1000).call({
      operation: "search_graph",
      params: {},
    });
    expect(r.ok).toBe(false);
  });
});
