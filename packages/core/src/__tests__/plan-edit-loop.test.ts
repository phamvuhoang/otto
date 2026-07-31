import { describe, expect, it } from "vitest";
import { resolvePlanEditLoop } from "../plan-checkpoint.js";

/**
 * A scripted operator: each call returns the next queued answer.
 *
 * An edit round consumes TWO reads — the "e" decision, then a bare Enter once
 * the on-disk edits are done. The operator only re-decides AFTER seeing the
 * re-scored verdict, which is the point of the loop.
 */
const operator = (answers: string[]) => {
  let i = 0;
  return async () => answers[i++] ?? "";
};

const deps = (answers: string[], extra = {}) => ({
  interactive: true,
  readLine: operator(answers),
  out: () => {},
  ...extra,
});

describe("resolvePlanEditLoop", () => {
  it("approve returns accept on the first pass", async () => {
    const r = await resolvePlanEditLoop("prompt", deps(["y"]), {
      rescore: async () => ({ passed: true, prompt: "re-scored" }),
    });
    expect(r).toBe("accept");
  });

  it("reject still pauses — edit is no longer collapsed into it", async () => {
    const r = await resolvePlanEditLoop("prompt", deps(["n"]), {
      rescore: async () => ({ passed: true, prompt: "re-scored" }),
    });
    expect(r).toBe("pause");
  });

  it("edit re-scores and accepts when the operator then approves", async () => {
    // The defect this fixes: `edit` used to be indistinguishable from `reject`.
    let rescored = 0;
    const r = await resolvePlanEditLoop("prompt", deps(["e", "", "y"]), {
      rescore: async () => {
        rescored += 1;
        return { passed: true, prompt: "re-scored" };
      },
    });
    expect(rescored).toBe(1);
    expect(r).toBe("accept");
  });

  it("allows several edit rounds", async () => {
    let rescored = 0;
    const r = await resolvePlanEditLoop(
      "prompt",
      deps(["e", "", "e", "", "y"]),
      {
        rescore: async () => {
          rescored += 1;
          return { passed: true, prompt: "re-scored" };
        },
      }
    );
    expect(rescored).toBe(2);
    expect(r).toBe("accept");
  });

  it("HUMAN AUTHORITY: an explicit approve wins even if the re-score fails", async () => {
    // The verdict was shown; the human outranks the heuristic.
    const r = await resolvePlanEditLoop("prompt", deps(["e", "", "y"]), {
      rescore: async () => ({ passed: false, prompt: "still failing" }),
    });
    expect(r).toBe("accept");
  });

  it("caps the edit rounds so a loop cannot spin forever", async () => {
    const r = await resolvePlanEditLoop(
      "prompt",
      deps(["e", "", "e", "", "e", "", "e", "", "e", ""]),
      { rescore: async () => ({ passed: false, prompt: "x" }), maxRounds: 3 }
    );
    expect(r).toBe("pause");
  });

  it("auto-approves in a non-interactive run, never blocking AFK", async () => {
    const r = await resolvePlanEditLoop(
      "prompt",
      { interactive: false, readLine: async () => "", out: () => {} },
      { rescore: async () => ({ passed: true, prompt: "x" }) }
    );
    expect(r).toBe("accept");
  });

  it("a timeout on an EDIT pauses rather than auto-approving", async () => {
    // The human explicitly took control by choosing edit, so silence must not
    // be read as consent the way it is at the initial checkpoint.
    const r = await resolvePlanEditLoop(
      "prompt",
      {
        interactive: true,
        out: () => {},
        readLine: (() => {
          let n = 0;
          return async (signal?: AbortSignal) => {
            if (n++ === 0) return "e";
            return new Promise<string>((_, rej) =>
              signal?.addEventListener("abort", () => rej(new Error("aborted")))
            );
          };
        })(),
        editTimeoutMs: 10,
      },
      { rescore: async () => ({ passed: true, prompt: "x" }) }
    );
    expect(r).toBe("pause");
  });
});
