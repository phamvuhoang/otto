import {
  diffWriteInventory,
  type CbmIndexIdentity,
  type CbmRunner,
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
