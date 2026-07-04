import { spawnSync } from "node:child_process";
import type { ToolDefinition, ToolOperation } from "./tools.js";

/**
 * Codebase Memory adapter (P26 spike, Task 2). Otto owns a local MCP stdio
 * child (`codebase-memory`) that builds and queries a code-knowledge graph
 * for the target repo — architecture summaries, call-path tracing, symbol
 * search — without any runtime network access. The adapter follows the same
 * house pattern as {@link ./headroom-adapter.js}: a {@link ToolDefinition}
 * factory for the `.otto/tools/` registry (`otto-tools list/why/health`,
 * policy authorization) plus an injectable transport ({@link CbmRunner}) so
 * unit tests never spawn a real process.
 *
 * The tool is opt-in and inert until a repo registers + enables it:
 * `stages: []` (no default injection into any stage template), `enabled:
 * false` (registry-level off switch), `networkDomains: []` (no runtime
 * network — the graph lives entirely in a local cache), and `writeRoots:
 * [".codebase-memory"]` (writes confined to its own cache directory).
 */

/** One JSON-RPC request to the codebase-memory MCP child. */
export type CbmRequest = {
  operation: string;
  params: Record<string, unknown>;
};

/** The structured response from a {@link CbmRunner} call. */
export type CbmResponse = { ok: boolean; result?: unknown; error?: string };

/**
 * The injectable transport the adapter drives. The real implementation
 * ({@link createStdioCbmRunner}) spawns the MCP child over stdio; unit tests
 * inject a stub — this contract is the seam.
 */
export type CbmRunner = {
  available(): boolean;
  call(req: CbmRequest): CbmResponse;
};

/** Read-only operations the codebase-memory server exposes. */
const READ_OPS = [
  "index_status",
  "get_graph_schema",
  "get_architecture",
  "search_graph",
  "trace_path",
  "detect_changes",
  "search_code",
  "get_code_snippet",
];

/** The full operation allowlist: one write op + the read-only surface. */
const OPERATIONS: ToolOperation[] = [
  { name: "index_repository", write: true },
  ...READ_OPS.map((name) => ({ name, write: false })),
];

/**
 * The {@link ToolDefinition} a repo drops into `.otto/tools/codebase-memory.json`
 * (mirrors {@link ./headroom-adapter.js}'s `headroomToolDefinition`). Declares
 * no runtime network, cache-only writes, and the operation allowlist
 * (`operations`) that a caller can gate calls against. `stages: []` and
 * `enabled: false` keep it fully opt-in — a bare repo behaves as before.
 */
export function codebaseMemoryToolDefinition(
  command = "codebase-memory"
): ToolDefinition {
  return {
    name: "codebase-memory",
    kind: "mcp",
    description:
      "Local code-knowledge graph via an Otto-owned MCP stdio child.",
    capabilities: [
      "architecture",
      "call-path",
      "change-impact",
      "symbol-search",
    ],
    stages: [], // opt-in via config; no default injection
    command,
    env: [],
    networkDomains: [], // no runtime network
    writeRoots: [".codebase-memory"], // cache-only
    secretRefs: [],
    timeoutMs: 120_000,
    healthCheck: `${command} --version`,
    approvalActions: [],
    enabled: false,
    operations: OPERATIONS,
  };
}

/**
 * Real transport: a minimal newline-delimited JSON-RPC client over stdio.
 * Sends an `initialize` handshake followed by one `tools/call`, both
 * newline-framed, and reads the child's stdout for the matching response.
 * Synchronous (`spawnSync`) to fit the same render/`@spill`-boundary
 * constraints as the Headroom runners. Only exercised under the gated e2e —
 * unit tests inject a {@link CbmRunner} stub instead.
 */
export function createStdioCbmRunner(
  command: string,
  cwd: string,
  timeoutMs: number
): CbmRunner {
  const [bin, ...args] = command.split(" ");
  const available = () => {
    const probe = spawnSync(bin, ["--version"], { cwd, timeout: 5000 });
    return probe.status === 0;
  };
  // One-shot request/response: initialize handshake + tools/call, newline-framed.
  const call = (req: CbmRequest): CbmResponse => {
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const callMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: req.operation, arguments: req.params },
    });
    const proc = spawnSync(bin, args, {
      cwd,
      timeout: timeoutMs,
      input: `${init}\n${callMsg}\n`,
    });
    if (proc.status !== 0)
      return { ok: false, error: proc.stderr?.toString() || "child failed" };
    const lines = proc.stdout.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 2 && msg.result) return { ok: true, result: msg.result };
        if (msg.id === 2 && msg.error)
          return { ok: false, error: String(msg.error.message ?? msg.error) };
      } catch {
        /* ignore non-JSON banner lines */
      }
    }
    return { ok: false, error: "no response for tools/call" };
  };
  return { available, call };
}
