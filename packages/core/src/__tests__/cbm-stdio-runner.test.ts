import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { createStdioCbmRunner } from "../codebase-memory-adapter.js";

const mockSpawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

const reply = (obj: unknown) => ({
  status: 0,
  stdout: Buffer.from(JSON.stringify(obj) + "\n"),
  stderr: Buffer.from(""),
});

beforeEach(() => mockSpawn.mockReset());

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
