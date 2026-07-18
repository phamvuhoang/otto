import {
  diffWriteInventory,
  classifyIndexFreshness,
  type CbmIndexIdentity,
  type CbmRunner,
  type IndexFreshness,
  type WriteInventory,
} from "./codebase-memory-adapter.js";

export type IndexResult = {
  ok: boolean;
  identity?: CbmIndexIdentity;
  fallbackReason?: string;
  writeInventory: WriteInventory;
};

export type IndexInputs = {
  runner: CbmRunner;
  scratchDir: string;
  /**
   * Directory the before/after snapshot walks to detect confinement escapes.
   * Must be broader than (or equal to) `scratchDir` — an escaped write that
   * lands outside `scratchDir` is only visible if the snapshot actually walks
   * past it. Defaults to `scratchDir` (preserves prior, scratch-only
   * behavior) when omitted.
   */
  watchDir?: string;
  declaredRoots: string[];
  snapshot: (dir: string) => string[];
  identity: Omit<CbmIndexIdentity, "indexStatus">;
};

const EMPTY_INVENTORY: WriteInventory = { files: [], escaped: [] };

/**
 * Run `index_repository` confined to `scratchDir`, then verify no write escaped
 * the declared roots. The before/after snapshot walks `watchDir` (default
 * `scratchDir`) rather than `scratchDir` itself, so a write that lands outside
 * the declared roots — e.g. at the workspace root, if the underlying tool
 * ignores `cacheDir` — is actually visible to the diff instead of silently
 * escaping detection. Any escape (or a failed call) aborts: the index is not
 * trusted and the caller falls back to normal search. Pure w.r.t. its injected
 * `snapshot`/`runner` — the loop supplies fs-backed impls.
 */
export function runIndexRepository(inputs: IndexInputs): IndexResult {
  const watchDir = inputs.watchDir ?? inputs.scratchDir;
  const before = inputs.snapshot(watchDir);
  const res = inputs.runner.call({
    operation: "index_repository",
    params: { cacheDir: inputs.scratchDir },
  });
  if (!res.ok) {
    return {
      ok: false,
      fallbackReason: `index_repository failed: ${res.error ?? "unknown"}`,
      writeInventory: EMPTY_INVENTORY,
    };
  }
  const after = inputs.snapshot(watchDir);
  const inventory = diffWriteInventory(before, after, inputs.declaredRoots);
  if (inventory.escaped.length > 0) {
    return {
      ok: false,
      fallbackReason: `index writes escaped confinement: ${inventory.escaped.join(", ")}`,
      writeInventory: inventory,
    };
  }
  return {
    ok: true,
    identity: { ...inputs.identity, indexStatus: "ready" },
    writeInventory: inventory,
  };
}

export type IndexAction = {
  action: "reuse" | "reindex";
  freshness: IndexFreshness;
  reason: string;
};

/**
 * Decides whether a persisted index can be reused as-is or must be rebuilt,
 * based on {@link classifyIndexFreshness}'s verdict against the current
 * workspace state. Pure — no filesystem access.
 */
export function decideIndexAction(
  current: {
    workspace: string;
    sourceRevision: string;
    worktreeDirty: boolean;
  } | null,
  persisted: CbmIndexIdentity | null
): IndexAction {
  const freshness = classifyIndexFreshness(current, persisted);
  return freshness === "fresh"
    ? { action: "reuse", freshness, reason: "index fresh" }
    : { action: "reindex", freshness, reason: `index ${freshness}` };
}

/**
 * Gates whether index-derived context is safe to inject into a prompt: only
 * a `fresh` index is trusted; anything else falls back with a reason.
 */
export function canInject(freshness: IndexFreshness): {
  inject: boolean;
  fallbackReason?: string;
} {
  return freshness === "fresh"
    ? { inject: true }
    : { inject: false, fallbackReason: `index ${freshness}` };
}
