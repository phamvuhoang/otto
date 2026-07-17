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
  declaredRoots: string[];
  snapshot: (dir: string) => string[];
  identity: Omit<CbmIndexIdentity, "indexStatus">;
};

const EMPTY_INVENTORY: WriteInventory = { files: [], escaped: [] };

/**
 * Run `index_repository` confined to `scratchDir`, then verify no write escaped
 * the declared roots. Any escape (or a failed call) aborts: the index is not
 * trusted and the caller falls back to normal search. Pure w.r.t. its injected
 * `snapshot`/`runner` — the loop supplies fs-backed impls.
 */
export function runIndexRepository(inputs: IndexInputs): IndexResult {
  const before = inputs.snapshot(inputs.scratchDir);
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
  const after = inputs.snapshot(inputs.scratchDir);
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
