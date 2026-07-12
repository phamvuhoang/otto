import { describe, expect, it } from "vitest";

import { createStdioCbmRunner } from "../codebase-memory-adapter.js";

// Real codebase-memory binary, no injected stub — proves the stdio adapter can
// actually round-trip a JSON-RPC call against an operator-provided Codebase
// Memory server (codebase-memory-adapter.test.ts already covers the parser and
// tool-definition shape against a stub). Gated behind OTTO_CBM_E2E=1 so the
// normal suite never requires the binary. Run it with:
//   OTTO_CBM_E2E=1 pnpm --filter @phamvuhoang/otto-core test -- cbm-e2e
// (the pinned binary must be installed and resolvable as `codebase-memory` on
// PATH, or point the runner at it via cwd/PATH before running).
const optedIn = process.env.OTTO_CBM_E2E === "1";
const runner = optedIn
  ? createStdioCbmRunner("codebase-memory", process.cwd(), 120_000)
  : null;
const maybe = optedIn && runner?.available() ? it : it.skip;

describe("codebase-memory real binary (gated)", () => {
  maybe("answers an architecture query over stdio", () => {
    const res = runner!.call({ operation: "get_architecture", params: {} });
    expect(res.ok).toBe(true);
  });
});
