# P12 Public Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At run end, Otto turns a generic memory learning into a short "field note" and, through an airtight default-deny secrecy gate, drafts it to disk (default) or publishes it to Threads (autonomous double opt-in) — never leaking repo/product/secret detail.

**Architecture:** A run-end hook in the harness (`runLoop`'s `finally`) selects a P3 memory learning, has the agent generalize it into a field note, runs it through three independent gates (deterministic deny-list → generalization check → adversarial LLM judge), and emits a draft or post. The agent only produces text; the harness owns the gates, audit log, ledger, and network egress. Off by default; a no-op unless the repo opts in.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` relative imports), vitest (`packages/core/src/__tests__`), native `fetch` (Node 20+), the existing `executeStage` agent runner and `readMemoryRecords`/`readSafetyPolicy`/`linear-api` patterns.

## Global Constraints

- **ESM only.** Every relative import in `packages/core/src/` ends in `.js`.
- **Off by default, zero behavior change.** No `journal` block in `.otto/config.json` (or `enabled:false`) ⇒ the run-end hook returns immediately: no stages, no files, no network.
- **Zero-leak hard gate (the invariant):** `screenEntry` is **default-deny** — it denies on the first gate failure, on an empty/over-long entry, and on **any thrown error**. A post that cannot be proven safe is never sent.
- **Privilege separation:** the sandboxed agent only produces text (the note, the judge verdict). The harness owns the gates, the audit trail, the ledger, and the HTTP post.
- **Posting requires a double opt-in:** `journal.autonomous: true` in config **AND** `OTTO_JOURNAL_AUTONOMOUS=1`. Otherwise draft-only.
- **The journal must never fail a run:** the hook swallows every error (audited) and never throws.
- **Threads limit:** a post is ≤ 500 characters.
- **Templates ship in the tarball** (`packages/core/package.json` `files`). New stage = add to `STAGES` + add `templates/<name>.md`.
- **Verify command:** `pnpm -r typecheck && pnpm -r test && pnpm test` (from repo root). Scoped: `pnpm --filter @phamvuhoang/otto-core test -- <name>`.

---

### Task 1: Secrecy Gate 1 — deterministic deny-list + audit trail

**Files:**
- Create: `packages/core/src/journal-gate.ts`
- Create: `packages/core/src/__tests__/journal-gate.test.ts`
- Modify: `packages/core/src/index.ts` (exports)

**Interfaces:**
- Produces:
  - `type GateContext = { repoIdentifiers: string[]; secretPatterns: string[] }`
  - `type GateResult = { ok: true } | { ok: false; gate: 1 | 2 | 3; reason: string }`
  - `function screenGate1(entry: string, ctx: GateContext): GateResult`
  - `function appendAudit(workspaceDir: string, line: Record<string, unknown>): void`
- Consumes: nothing (pure + an fs append).

- [ ] **Step 1: Write the failing tests for Gate 1**

Create `packages/core/src/__tests__/journal-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { screenGate1, type GateContext } from "../journal-gate.js";

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  repoIdentifiers: ["otto", "phamvuhoang"],
  secretPatterns: [],
  ...over,
});

const ok = (s: string) => expect(screenGate1(s, ctx())).toEqual({ ok: true });
const deny = (s: string, c = ctx()) => {
  const r = screenGate1(s, c);
  expect(r.ok).toBe(false);
  return r;
};

describe("screenGate1 — deny-list", () => {
  it("passes a clean generic craft note", () => {
    ok("Today I learned to write the failing test before the fix — it kept my changes honest.");
  });
  it("denies token/secret shapes", () => {
    deny("My key is sk-abcd1234abcd1234abcd1234.");
    deny("export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    deny("password=hunter2 in the config");
    deny("-----BEGIN RSA PRIVATE KEY-----");
    deny("Authorization: Bearer abcdef.ghijkl.mnopqr");
  });
  it("denies URLs, paths, and code fences/spans", () => {
    deny("see https://example.com/secret");
    deny("the bug was in /Users/me/proj/src/loop.ts");
    deny("relative path ./packages/core/src/x.ts broke");
    deny("```ts\nconst x = 1;\n```");
    deny("inline `runLoop()` call");
  });
  it("denies the repo's own identifiers (case-insensitive, word-ish)", () => {
    deny("I was working in the Otto harness today.");
    deny("phamvuhoang/otto had a flaky test.");
  });
  it("denies policy secretPatterns and survives a malformed pattern", () => {
    deny("acme-internal build broke", ctx({ secretPatterns: ["acme-internal"] }));
    // a malformed regex must DENY, not throw
    const r = screenGate1("totally fine text", ctx({ secretPatterns: ["("] }));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-gate`
Expected: FAIL — `Cannot find module '../journal-gate.js'`.

- [ ] **Step 3: Implement Gate 1 + audit append**

Create `packages/core/src/journal-gate.ts`:

```ts
/**
 * The P12 outbound secrecy gate (issue #67). Layered, default-deny: a journal
 * note is published only if it passes every gate. Gate 1 (here) is the pure,
 * deterministic deny-list — the backbone. Gates 2 (generalization) and 3
 * (adversarial judge) are added in later tasks. ZERO-LEAK is the hard gate:
 * anything ambiguous is denied, and a thrown check denies rather than crashes.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type GateContext = {
  /** This repo's own identifiers (name, owner, remote host, dir basename, top files). */
  repoIdentifiers: string[];
  /** Extra deny patterns from SafetyPolicy.secretPatterns (.otto/policy.json). */
  secretPatterns: string[];
};

export type GateResult =
  | { ok: true }
  | { ok: false; gate: 1 | 2 | 3; reason: string };

/** Built-in secret/identifier deny patterns. Each is intentionally broad — this
 *  gate is biased to over-deny. Names are logged (not the matched secret). */
const DENY: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{12,}/ },
  { name: "github-token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{8,}/i },
  { name: "assignment-secret", re: /\b(password|passwd|secret|api[_-]?key|token|access[_-]?key)\b\s*[:=]\s*\S+/i },
  { name: "url", re: /\bhttps?:\/\/\S+/i },
  { name: "abs-path", re: /(^|\s)(\/[\w.-]+){2,}/ },
  { name: "rel-path", re: /(^|\s)\.{1,2}\/[\w./-]+/ },
  { name: "win-path", re: /\b[A-Za-z]:\\[\\\w.-]+/ },
  { name: "code-fence", re: /```/ },
  { name: "code-span", re: /`[^`]+`/ },
  { name: "scoped-pkg", re: /(^|\s)@[a-z0-9-]+\/[a-z0-9-]+/i },
  { name: "import-stmt", re: /\b(import\s.+\sfrom\s|require\s*\()/ },
];

/** Build a word-ish, case-insensitive matcher for a repo identifier. */
function identifierRe(id: string): RegExp | null {
  const trimmed = id.trim();
  if (trimmed.length < 3) return null; // too short → too many false denials
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i");
}

/**
 * Gate 1: deny if the entry matches any built-in secret/identifier pattern, any
 * repo self-identifier, or any policy secretPattern. A malformed policy pattern
 * is treated as a denial (fail closed). Pure except for never mutating inputs.
 */
export function screenGate1(entry: string, ctx: GateContext): GateResult {
  for (const { name, re } of DENY) {
    if (re.test(entry)) return { ok: false, gate: 1, reason: `deny:${name}` };
  }
  for (const id of ctx.repoIdentifiers) {
    const re = identifierRe(id);
    if (re && re.test(entry)) {
      return { ok: false, gate: 1, reason: "deny:repo-identifier" };
    }
  }
  for (const pattern of ctx.secretPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      // a malformed policy pattern fails closed — we cannot prove safety.
      return { ok: false, gate: 1, reason: "deny:malformed-policy-pattern" };
    }
    if (re.test(entry)) {
      return { ok: false, gate: 1, reason: "deny:policy-secret-pattern" };
    }
  }
  return { ok: true };
}

/** Append one JSON line to the journal audit trail. Never throws. */
export function appendAudit(
  workspaceDir: string,
  line: Record<string, unknown>
): void {
  try {
    const path = join(workspaceDir, ".otto", "journal", "audit.log");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ...line, at: line.at ?? "" }) + "\n", "utf8");
  } catch {
    // the audit log is best-effort; never crash a run over it.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-gate`
Expected: PASS (all Gate 1 cases).

- [ ] **Step 5: Export + commit**

Add to `packages/core/src/index.ts` (match existing style):
```ts
export {
  appendAudit,
  screenGate1,
  type GateContext,
  type GateResult,
} from "./journal-gate.js";
```

Run: `pnpm --filter @phamvuhoang/otto-core typecheck`

```bash
git add packages/core/src/journal-gate.ts packages/core/src/__tests__/journal-gate.test.ts packages/core/src/index.ts
git commit -m "feat(core): journal secrecy gate 1 — deterministic deny-list (#67 P12 slice 1)"
```

---

### Task 2: Gate 2 (generalization) + `screenEntry` orchestrator

**Files:**
- Modify: `packages/core/src/journal-gate.ts`
- Modify: `packages/core/src/__tests__/journal-gate.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `screenGate1`, `GateContext`, `GateResult` (Task 1).
- Produces:
  - `const MAX_ENTRY_CHARS = 500`, `const MIN_ENTRY_CHARS = 20`
  - `function screenGate2(entry: string, ctx: GateContext): GateResult`
  - `type Gate3Judge = (entry: string) => Promise<boolean>` (true = SAFE)
  - `async function screenEntry(entry: string, ctx: GateContext, judge?: Gate3Judge): Promise<GateResult>` — runs Gate 1 → 2 → (optional) 3; default-deny on empty, over-length, or any throw.
- Note: `GateContext` gains `forbiddenTerms: string[]` (the source record's taskKey / scope / run id). Update the type and Task 1 tests' `ctx()` helper to default `forbiddenTerms: []`.

- [ ] **Step 1: Write the failing tests**

Add to `journal-gate.test.ts` (and update the `ctx()` helper to include `forbiddenTerms: []`):

```ts
import { screenGate2, screenEntry, MAX_ENTRY_CHARS } from "../journal-gate.js";

describe("screenGate2 — generalization", () => {
  it("passes generic craft prose", () => {
    expect(screenGate2("Writing the test first kept me honest about the real requirement.", ctx()).ok).toBe(true);
  });
  it("denies task-key shapes", () => {
    expect(screenGate2("fixed issue-42 today", ctx()).ok).toBe(false);
    expect(screenGate2("the ticket ENG-1234 was tricky", ctx()).ok).toBe(false);
  });
  it("denies forbidden source terms (scope/taskKey/run)", () => {
    expect(screenGate2("the parser module was the cause", ctx({ forbiddenTerms: ["parser"] })).ok).toBe(false);
  });
  it("denies an over-length or too-short note", () => {
    expect(screenGate2("x".repeat(MAX_ENTRY_CHARS + 1), ctx()).ok).toBe(false);
    expect(screenGate2("too short", ctx()).ok).toBe(false);
  });
});

describe("screenEntry — orchestrator (default-deny)", () => {
  const clean = "Writing the failing test before the change kept my work honest and focused.";
  it("passes a clean note through gates 1+2 with no judge", async () => {
    expect((await screenEntry(clean, ctx())).ok).toBe(true);
  });
  it("denies when the judge says unsafe", async () => {
    const r = await screenEntry(clean, ctx(), async () => false);
    expect(r).toMatchObject({ ok: false, gate: 3 });
  });
  it("denies when the judge throws (fail closed)", async () => {
    const r = await screenEntry(clean, ctx(), async () => {
      throw new Error("boom");
    });
    expect(r.ok).toBe(false);
  });
  it("short-circuits at gate 1 before calling the judge", async () => {
    let called = false;
    const r = await screenEntry("leak https://x.com", ctx(), async () => {
      called = true;
      return true;
    });
    expect(r).toMatchObject({ ok: false, gate: 1 });
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-gate`
Expected: FAIL — `screenGate2`/`screenEntry`/`MAX_ENTRY_CHARS` not exported; `forbiddenTerms` missing on `GateContext`.

- [ ] **Step 3: Implement Gate 2 + orchestrator**

In `journal-gate.ts`, add `forbiddenTerms: string[]` to `GateContext`, then append:

```ts
export const MAX_ENTRY_CHARS = 500;
export const MIN_ENTRY_CHARS = 20;

/** Shapes that betray a specific task/ticket. */
const TASK_KEY_RE = /\b(issue-\d+|[A-Z]{2,}-\d+)\b/;

/**
 * Gate 2: the note must read as GENERIC craft. Deny task-key shapes, any term
 * carried from the source record (scope globs / taskKey / run id), and notes
 * outside the length bounds. Pure.
 */
export function screenGate2(entry: string, ctx: GateContext): GateResult {
  const text = entry.trim();
  if (text.length < MIN_ENTRY_CHARS || text.length > MAX_ENTRY_CHARS) {
    return { ok: false, gate: 2, reason: "deny:length" };
  }
  if (TASK_KEY_RE.test(text)) return { ok: false, gate: 2, reason: "deny:task-key" };
  for (const term of ctx.forbiddenTerms) {
    const t = term.trim();
    if (t.length >= 3 && new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) {
      return { ok: false, gate: 2, reason: "deny:forbidden-term" };
    }
  }
  return { ok: true };
}

export type Gate3Judge = (entry: string) => Promise<boolean>;

/**
 * Run the full gate: 1 (deny-list) → 2 (generalization) → 3 (judge, optional).
 * Default-deny: a thrown judge, an empty entry, or any non-pass denies. The
 * judge runs LAST and only on an entry the deterministic gates already passed.
 */
export async function screenEntry(
  entry: string,
  ctx: GateContext,
  judge?: Gate3Judge
): Promise<GateResult> {
  if (!entry || !entry.trim()) return { ok: false, gate: 1, reason: "deny:empty" };
  const g1 = screenGate1(entry, ctx);
  if (!g1.ok) return g1;
  const g2 = screenGate2(entry, ctx);
  if (!g2.ok) return g2;
  if (judge) {
    try {
      const safe = await judge(entry);
      if (!safe) return { ok: false, gate: 3, reason: "deny:judge-unsafe" };
    } catch {
      return { ok: false, gate: 3, reason: "deny:judge-error" };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-gate`
Expected: PASS.

- [ ] **Step 5: Export + commit**

Add to `index.ts` export block from `./journal-gate.js`: `screenGate2`, `screenEntry`, `MAX_ENTRY_CHARS`, `MIN_ENTRY_CHARS`, `type Gate3Judge`.

```bash
git add packages/core/src/journal-gate.ts packages/core/src/__tests__/journal-gate.test.ts packages/core/src/index.ts
git commit -m "feat(core): journal gate 2 + screenEntry orchestrator (#67 P12 slice 2)"
```

---

### Task 3: Threads API client

**Files:**
- Create: `packages/core/src/threads-api.ts`
- Create: `packages/core/src/__tests__/threads-api.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `type ThreadsAuth = { token: string; userId: string; source: string }`
  - `function resolveThreadsAuth(deps?): ThreadsAuth | null`
  - `type ThreadsClient = { publish(text: string): Promise<{ id: string }> }`
  - `function createThreadsClient(opts: { token: string; userId: string; fetch?: typeof fetch; baseUrl?: string }): ThreadsClient`
  - `class ThreadsApiError extends Error { kind: "auth" | "network" | "api" }`
- Consumes: nothing (mirrors `linear-api.ts`).

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/threads-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createThreadsClient,
  resolveThreadsAuth,
  ThreadsApiError,
} from "../threads-api.js";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

describe("resolveThreadsAuth", () => {
  const deps = (env: Record<string, string>, file: string | null = null) => ({
    env,
    readFile: () => file,
    home: "/home/x",
  });
  it("reads env token + user id", () => {
    expect(
      resolveThreadsAuth(deps({ OTTO_THREADS_TOKEN: "t", OTTO_THREADS_USER_ID: "u" }))
    ).toMatchObject({ token: "t", userId: "u" });
  });
  it("falls back to the config file", () => {
    expect(
      resolveThreadsAuth(deps({}, JSON.stringify({ token: "ft", userId: "fu" })))
    ).toMatchObject({ token: "ft", userId: "fu" });
  });
  it("returns null when nothing is set", () => {
    expect(resolveThreadsAuth(deps({}))).toBeNull();
  });
});

describe("createThreadsClient.publish", () => {
  it("does the two-step create then publish and returns the post id", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("threads_publish")) return okJson({ id: "post-9" });
      return okJson({ id: "creation-1" });
    }) as unknown as typeof fetch;
    const client = createThreadsClient({ token: "tok", userId: "u1", fetch: fetchImpl });
    const res = await client.publish("hello world");
    expect(res).toEqual({ id: "post-9" });
    expect(calls[0]).toContain("/u1/threads");
    expect(calls[0]).toContain("text=hello");
    expect(calls[1]).toContain("/u1/threads_publish");
    expect(calls[1]).toContain("creation_id=creation-1");
  });
  it("classifies a non-ok response as an api error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "bad" }) }) as Response) as unknown as typeof fetch;
    const client = createThreadsClient({ token: "tok", userId: "u1", fetch: fetchImpl });
    await expect(client.publish("x".repeat(30))).rejects.toMatchObject({ kind: "api" });
  });
  it("classifies a fetch throw as a network error", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const client = createThreadsClient({ token: "tok", userId: "u1", fetch: fetchImpl });
    await expect(client.publish("x".repeat(30))).rejects.toMatchObject({ kind: "network" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- threads-api`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `threads-api.ts`**

```ts
/**
 * Threads (Meta) publishing client for the P12 public journal (issue #67).
 * Mirrors linear-api.ts: injectable fetch + credentials from env or
 * ~/.config/otto/threads.json. The Threads Graph API publishes in two steps —
 * create a TEXT container, then publish it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThreadsAuth = { token: string; userId: string; source: string };

export type ThreadsAuthDeps = {
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => string | null;
  home: string;
};

const defaultAuthDeps: ThreadsAuthDeps = {
  env: process.env,
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  home: homedir(),
};

export function threadsConfigPath(home: string): string {
  return join(home, ".config", "otto", "threads.json");
}

/** Resolve token + user id from env, else ~/.config/otto/threads.json. null = unconfigured. */
export function resolveThreadsAuth(
  deps: ThreadsAuthDeps = defaultAuthDeps
): ThreadsAuth | null {
  const token = deps.env.OTTO_THREADS_TOKEN?.trim();
  const userId = deps.env.OTTO_THREADS_USER_ID?.trim();
  if (token && userId) return { token, userId, source: "env" };

  const path = threadsConfigPath(deps.home);
  const raw = deps.readFile(path);
  if (raw != null) {
    try {
      const o = JSON.parse(raw) as { token?: unknown; userId?: unknown };
      if (typeof o.token === "string" && o.token.trim() && typeof o.userId === "string" && o.userId.trim()) {
        return { token: o.token.trim(), userId: o.userId.trim(), source: path };
      }
    } catch {
      // malformed → no credential from this source
    }
  }
  return null;
}

export type ThreadsErrorKind = "auth" | "network" | "api";
export class ThreadsApiError extends Error {
  kind: ThreadsErrorKind;
  constructor(message: string, kind: ThreadsErrorKind) {
    super(message);
    this.name = "ThreadsApiError";
    this.kind = kind;
  }
}

export type ThreadsClient = { publish(text: string): Promise<{ id: string }> };

const DEFAULT_BASE = "https://graph.threads.net/v1.0";

export function createThreadsClient(opts: {
  token: string;
  userId: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}): ThreadsClient {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? DEFAULT_BASE;
  if (!opts.token || !opts.userId) {
    throw new ThreadsApiError("missing Threads credentials", "auth");
  }

  const post = async (url: string): Promise<{ id: string }> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST" });
    } catch (e) {
      throw new ThreadsApiError(`Threads request failed: ${(e as Error).message}`, "network");
    }
    if (!res.ok) {
      throw new ThreadsApiError(`Threads API returned ${res.status}`, "api");
    }
    const json = (await res.json()) as { id?: unknown };
    if (typeof json.id !== "string") {
      throw new ThreadsApiError("Threads API response missing id", "api");
    }
    return { id: json.id };
  };

  return {
    async publish(text: string): Promise<{ id: string }> {
      const tok = encodeURIComponent(opts.token);
      const create = `${base}/${opts.userId}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&access_token=${tok}`;
      const { id: creationId } = await post(create);
      const publish = `${base}/${opts.userId}/threads_publish?creation_id=${encodeURIComponent(creationId)}&access_token=${tok}`;
      return post(publish);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- threads-api`
Expected: PASS.

- [ ] **Step 5: Export + commit**

Add to `index.ts`: `createThreadsClient`, `resolveThreadsAuth`, `threadsConfigPath`, `ThreadsApiError`, `type ThreadsAuth`, `type ThreadsClient`.

```bash
git add packages/core/src/threads-api.ts packages/core/src/__tests__/threads-api.test.ts packages/core/src/index.ts
git commit -m "feat(core): threads-api client + credential resolution (#67 P12 slice 3)"
```

---

### Task 4: Candidate selection + dedup/cadence ledger

**Files:**
- Create: `packages/core/src/journal-source.ts`
- Create: `packages/core/src/journal-ledger.ts`
- Create: `packages/core/src/__tests__/journal-source.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `MemoryRecord`, `readMemoryRecords`, `memoryStatus` from `./memory.js`.
- Produces:
  - `journal-ledger.ts`: `type PostedEntry = { memoryId: string; contentHash: string; postedAt: string; postId?: string }`; `function hashContent(s: string): string`; `function readLedger(workspaceDir): PostedEntry[]`; `function appendLedger(workspaceDir, entry: PostedEntry): void`; `function recentlyPosted(ledger, minDays, now): boolean`.
  - `journal-source.ts`: `function selectCandidate(records: MemoryRecord[], opts: { categories: string[]; postedIds: Set<string>; now: Date }): MemoryRecord | null` (active, journal-worthy category, not already posted, ranked by `confidence`; ties broken by newer `createdAt`).
  - `function forbiddenTermsFor(record: MemoryRecord): string[]` (its `scope` globs + `taskKey` + `sourceRun`, split into word-ish terms).

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/journal-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectCandidate, forbiddenTermsFor } from "../journal-source.js";
import { hashContent, recentlyPosted } from "../journal-ledger.js";
import type { MemoryRecord } from "../memory.js";

const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
  id: "m1", content: "c", scope: [], confidence: 0.5, trust: "trusted",
  status: "active", createdAt: "2026-06-01T00:00:00.000Z", useCount: 0, ...over,
});

describe("selectCandidate", () => {
  const now = new Date("2026-06-20T00:00:00.000Z");
  it("picks the highest-confidence active journal-worthy record not yet posted", () => {
    const recs = [
      rec({ id: "a", category: "gotcha", confidence: 0.4 }),
      rec({ id: "b", category: "gotcha", confidence: 0.9 }),
      rec({ id: "c", category: "convention", confidence: 0.99 }), // wrong category
    ];
    const pick = selectCandidate(recs, { categories: ["gotcha", "dead-end"], postedIds: new Set(), now });
    expect(pick?.id).toBe("b");
  });
  it("excludes already-posted ids and returns null when none qualify", () => {
    const recs = [rec({ id: "b", category: "gotcha", confidence: 0.9 })];
    expect(selectCandidate(recs, { categories: ["gotcha"], postedIds: new Set(["b"]), now })).toBeNull();
  });
});

describe("forbiddenTermsFor", () => {
  it("collects scope globs, taskKey and run id as terms", () => {
    const terms = forbiddenTermsFor(rec({ scope: ["packages/core/**"], taskKey: "issue-42", sourceRun: "run-7" }));
    expect(terms).toContain("issue-42");
    expect(terms.some((t) => t.includes("core"))).toBe(true);
  });
});

describe("ledger", () => {
  it("hashContent is stable + recentlyPosted respects the window", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    const ledger = [{ memoryId: "m", contentHash: "h", postedAt: "2026-06-19T00:00:00.000Z" }];
    expect(recentlyPosted(ledger, 1, new Date("2026-06-19T12:00:00.000Z"))).toBe(true);
    expect(recentlyPosted(ledger, 1, new Date("2026-06-21T00:00:00.000Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-source`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `journal-ledger.ts`**

```ts
/** Posted-entry ledger + cadence/dedup for the P12 journal (issue #67). */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export type PostedEntry = {
  memoryId: string;
  contentHash: string;
  postedAt: string;
  postId?: string;
};

const ledgerPath = (workspaceDir: string): string =>
  join(workspaceDir, ".otto", "journal", "posted.json");

export function hashContent(s: string): string {
  return createHash("sha256").update(s.trim()).digest("hex").slice(0, 16);
}

export function readLedger(workspaceDir: string): PostedEntry[] {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(workspaceDir), "utf8"));
    return Array.isArray(raw) ? (raw as PostedEntry[]) : [];
  } catch {
    return [];
  }
}

export function appendLedger(workspaceDir: string, entry: PostedEntry): void {
  const path = ledgerPath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true });
  const next = [...readLedger(workspaceDir), entry];
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
}

/** True if the newest post is younger than `minDays` before `now`. */
export function recentlyPosted(
  ledger: PostedEntry[],
  minDays: number,
  now: Date
): boolean {
  if (ledger.length === 0 || minDays <= 0) return false;
  const newest = ledger.reduce((a, b) => (a.postedAt > b.postedAt ? a : b));
  const ageMs = now.getTime() - new Date(newest.postedAt).getTime();
  return ageMs < minDays * 24 * 60 * 60 * 1000;
}
```
(`appendFileSync` import unused → remove it; keep `writeFileSync`.)

- [ ] **Step 4: Implement `journal-source.ts`**

```ts
/** Select a journal-worthy memory record + derive its forbidden terms (#67 P12). */
import type { MemoryRecord } from "./memory.js";
import { memoryStatus } from "./memory.js";

export function selectCandidate(
  records: MemoryRecord[],
  opts: { categories: string[]; postedIds: Set<string>; now: Date }
): MemoryRecord | null {
  const eligible = records.filter(
    (r) =>
      memoryStatus(r, opts.now) === "active" &&
      r.category != null &&
      opts.categories.includes(r.category) &&
      !opts.postedIds.has(r.id)
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) =>
    b.confidence !== a.confidence
      ? b.confidence - a.confidence
      : b.createdAt.localeCompare(a.createdAt)
  );
  return eligible[0];
}

/** Identifiers carried by a record that must not survive into a post. */
export function forbiddenTermsFor(record: MemoryRecord): string[] {
  const terms = new Set<string>();
  if (record.taskKey) terms.add(record.taskKey);
  if (record.sourceRun) terms.add(record.sourceRun);
  for (const glob of record.scope) {
    for (const part of glob.split(/[/*.\s]+/)) {
      if (part.length >= 3) terms.add(part);
    }
  }
  return [...terms];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-source`
Expected: PASS.

- [ ] **Step 6: Export + commit**

Add to `index.ts`: from `./journal-source.js` (`selectCandidate`, `forbiddenTermsFor`) and `./journal-ledger.js` (`hashContent`, `readLedger`, `appendLedger`, `recentlyPosted`, `type PostedEntry`).

```bash
git add packages/core/src/journal-source.ts packages/core/src/journal-ledger.ts packages/core/src/__tests__/journal-source.test.ts packages/core/src/index.ts
git commit -m "feat(core): journal candidate selection + dedup/cadence ledger (#67 P12 slice 4)"
```

---

### Task 5: Agent stages — generate + judge

**Files:**
- Create: `packages/core/templates/journal-write.md`
- Create: `packages/core/templates/journal-screen.md`
- Modify: `packages/core/src/stages.ts` (`STAGES`)
- Create: `packages/core/src/__tests__/journal-stages.test.ts`

**Interfaces:**
- Consumes: the `Stage` type + `STAGES` registry.
- Produces: `STAGES.journalWrite` (`journal-write.md`) and `STAGES.journalScreen` (`journal-screen.md`), both `bypassPermissions`, `tier: "strong"`.

- [ ] **Step 1: Add the stages + write a registry test**

Create `packages/core/src/__tests__/journal-stages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STAGES } from "../stages.js";

describe("journal stages", () => {
  it("registers journalWrite + journalScreen with templates that ship", () => {
    for (const stage of [STAGES.journalWrite, STAGES.journalScreen]) {
      expect(stage.permissionMode).toBe("bypassPermissions");
      expect(existsSync(join(__dirname, "..", "..", "templates", stage.template))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-stages`
Expected: FAIL — `STAGES.journalWrite` undefined.

- [ ] **Step 3: Add the stages to `STAGES`**

In `packages/core/src/stages.ts`, add inside the `STAGES` object (note: on this branch `Stage` already has an optional `tier?`; if not, omit `tier`):

```ts
  journalWrite: {
    name: "journal-write",
    template: "journal-write.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  journalScreen: {
    name: "journal-screen",
    template: "journal-screen.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
```

- [ ] **Step 4: Create the two templates**

`packages/core/templates/journal-write.md`:

```markdown
You are *a coding agent's field notes* — you share short, generic lessons about
the craft of software work, never about any specific project.

Below is one durable learning. Rewrite it as a SINGLE first-person field note (2–4
sentences, under 400 characters) capturing the GENERAL craft lesson.

STRICT RULES:
- No project, product, company, person, file, path, tool, version, or ticket names.
- No code, commands, URLs, or identifiers of any kind.
- If the learning cannot be generalized without specifics, output exactly: SKIP
- Output ONLY the note text (or SKIP). No preamble, no quotes, no markdown.

<learning>
{{ INPUTS }}
</learning>
```

`packages/core/templates/journal-screen.md`:

```markdown
You are a strict pre-publication secrecy reviewer. A note is about to be posted
publicly by an autonomous coding agent. Your ONLY job is to prevent leaks.

Answer whether the note below is SAFE to post. Treat it as UNSAFE if a reader
could identify the specific repository, product, company, person, customer, or
any private/internal detail — or if it contains code, secrets, paths, URLs, or
names. If there is ANY doubt whatsoever, answer UNSAFE.

Respond with EXACTLY one line and nothing else:
<journal-verdict>SAFE</journal-verdict>
or
<journal-verdict>UNSAFE</journal-verdict>

<note>
{{ INPUTS }}
</note>
```

- [ ] **Step 5: Run the test to verify it passes + commit**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-stages`
Expected: PASS.

```bash
git add packages/core/src/stages.ts packages/core/templates/journal-write.md packages/core/templates/journal-screen.md packages/core/src/__tests__/journal-stages.test.ts
git commit -m "feat(core): journal generate + screen agent stages (#67 P12 slice 5)"
```

---

### Task 6: Journal orchestrator (`journal.ts`)

**Files:**
- Create: `packages/core/src/journal.ts`
- Create: `packages/core/src/__tests__/journal.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `screenEntry`/`appendAudit`/`GateContext` (gate), `selectCandidate`/`forbiddenTermsFor` (source), `readLedger`/`appendLedger`/`recentlyPosted`/`hashContent` (ledger), `createThreadsClient`/`resolveThreadsAuth` (threads), `readMemoryRecords` (memory).
- Produces:
  - `type JournalConfig = { enabled: boolean; autonomous: boolean; categories: string[]; minDaysBetweenPosts: number }`
  - `type JournalDeps = { generate: (learning: string) => Promise<string>; judge: (note: string) => Promise<boolean>; publish?: (text: string) => Promise<{ id: string }>; repoIdentifiers: string[]; secretPatterns: string[]; now: () => Date }`
  - `type JournalOutcome = { action: "disabled" | "no-candidate" | "skipped-cadence" | "denied" | "drafted" | "posted"; reason?: string }`
  - `async function runJournal(workspaceDir: string, config: JournalConfig, deps: JournalDeps): Promise<JournalOutcome>` — the pure-ish orchestrator (all I/O injected except fs draft/ledger/audit writes). Never throws.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/journal.test.ts` using a temp workspace with one memory record, and injected deps. Cover:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJournal, type JournalConfig, type JournalDeps } from "../journal.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "otto-journal-"));
  mkdirSync(join(ws, ".otto", "memory"), { recursive: true });
  writeFileSync(
    join(ws, ".otto", "memory", "m1.json"),
    JSON.stringify({ id: "m1", content: "remember to test first", category: "gotcha", scope: [], confidence: 0.9, trust: "trusted", status: "active", createdAt: "2026-06-01T00:00:00.000Z", useCount: 0 })
  );
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const cfg = (over: Partial<JournalConfig> = {}): JournalConfig => ({
  enabled: true, autonomous: false, categories: ["gotcha"], minDaysBetweenPosts: 1, ...over,
});
const deps = (over: Partial<JournalDeps> = {}): JournalDeps => ({
  generate: async () => "Writing the failing test first keeps my changes honest and focused on the real requirement.",
  judge: async () => true,
  repoIdentifiers: ["otto"],
  secretPatterns: [],
  now: () => new Date("2026-06-20T00:00:00.000Z"),
  ...over,
});

it("disabled config is a complete no-op", async () => {
  const out = await runJournal(ws, cfg({ enabled: false }), deps());
  expect(out.action).toBe("disabled");
  expect(existsSync(join(ws, ".otto", "journal"))).toBe(false);
});

it("default mode drafts to disk and never publishes", async () => {
  let published = false;
  const out = await runJournal(ws, cfg(), deps({ publish: async () => { published = true; return { id: "x" }; } }));
  expect(out.action).toBe("drafted");
  expect(published).toBe(false);
  expect(existsSync(join(ws, ".otto", "journal", "drafts"))).toBe(true);
});

it("autonomous mode posts a gate-passing note exactly once and records the ledger", async () => {
  const out = await runJournal(ws, cfg({ autonomous: true }), deps({ publish: async () => ({ id: "post-1" }) }));
  expect(out.action).toBe("posted");
  const ledger = JSON.parse(readFileSync(join(ws, ".otto", "journal", "posted.json"), "utf8"));
  expect(ledger).toHaveLength(1);
  expect(ledger[0].memoryId).toBe("m1");
});

it("a judge-unsafe verdict denies and never publishes", async () => {
  let published = false;
  const out = await runJournal(ws, cfg({ autonomous: true }), deps({ judge: async () => false, publish: async () => { published = true; return { id: "x" }; } }));
  expect(out.action).toBe("denied");
  expect(published).toBe(false);
});

it("a SKIP generation denies (no candidate note)", async () => {
  const out = await runJournal(ws, cfg(), deps({ generate: async () => "SKIP" }));
  expect(out.action).toBe("denied");
});

it("respects cadence: a recent post skips", async () => {
  mkdirSync(join(ws, ".otto", "journal"), { recursive: true });
  writeFileSync(join(ws, ".otto", "journal", "posted.json"), JSON.stringify([{ memoryId: "other", contentHash: "h", postedAt: "2026-06-19T18:00:00.000Z" }]));
  const out = await runJournal(ws, cfg({ autonomous: true }), deps());
  expect(out.action).toBe("skipped-cadence");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal.test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `journal.ts`**

```ts
/**
 * P12 journal orchestrator (issue #67): select a memory learning → generate a
 * field note → run the default-deny secrecy gate → draft (default) or post
 * (autonomous). All model/network I/O is injected; never throws.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit, screenEntry, type GateContext } from "./journal-gate.js";
import { forbiddenTermsFor, selectCandidate } from "./journal-source.js";
import {
  appendLedger,
  hashContent,
  readLedger,
  recentlyPosted,
} from "./journal-ledger.js";
import { readMemoryRecords } from "./memory.js";

export type JournalConfig = {
  enabled: boolean;
  autonomous: boolean;
  categories: string[];
  minDaysBetweenPosts: number;
};

export type JournalDeps = {
  generate: (learning: string) => Promise<string>;
  judge: (note: string) => Promise<boolean>;
  publish?: (text: string) => Promise<{ id: string }>;
  repoIdentifiers: string[];
  secretPatterns: string[];
  now: () => Date;
};

export type JournalAction =
  | "disabled" | "no-candidate" | "skipped-cadence" | "denied" | "drafted" | "posted";
export type JournalOutcome = { action: JournalAction; reason?: string };

export async function runJournal(
  workspaceDir: string,
  config: JournalConfig,
  deps: JournalDeps
): Promise<JournalOutcome> {
  try {
    if (!config.enabled) return { action: "disabled" };
    const now = deps.now();

    const ledger = readLedger(workspaceDir);
    if (recentlyPosted(ledger, config.minDaysBetweenPosts, now)) {
      return { action: "skipped-cadence" };
    }

    const postedIds = new Set(ledger.map((e) => e.memoryId));
    const candidate = selectCandidate(readMemoryRecords(workspaceDir), {
      categories: config.categories,
      postedIds,
      now,
    });
    if (!candidate) return { action: "no-candidate" };

    const note = (await deps.generate(candidate.content)).trim();
    const ctx: GateContext = {
      repoIdentifiers: deps.repoIdentifiers,
      secretPatterns: deps.secretPatterns,
      forbiddenTerms: forbiddenTermsFor(candidate),
    };
    const verdict =
      note === "SKIP" || note === ""
        ? { ok: false as const, gate: 1 as const, reason: "deny:generation-skip" }
        : await screenEntry(note, ctx, deps.judge);

    if (!verdict.ok) {
      appendAudit(workspaceDir, {
        at: now.toISOString(), memoryId: candidate.id,
        decision: "denied", gate: verdict.gate, reason: verdict.reason,
      });
      return { action: "denied", reason: verdict.reason };
    }

    // Passed every gate. Default mode drafts; autonomous posts.
    if (!config.autonomous || !deps.publish) {
      const dir = join(workspaceDir, ".otto", "journal", "drafts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${candidate.id}.md`), note + "\n", "utf8");
      appendAudit(workspaceDir, { at: now.toISOString(), memoryId: candidate.id, decision: "drafted" });
      return { action: "drafted" };
    }

    const { id } = await deps.publish(note);
    appendLedger(workspaceDir, {
      memoryId: candidate.id, contentHash: hashContent(note),
      postedAt: now.toISOString(), postId: id,
    });
    appendAudit(workspaceDir, { at: now.toISOString(), memoryId: candidate.id, decision: "posted", postId: id });
    return { action: "posted" };
  } catch (err) {
    appendAudit(workspaceDir, { decision: "error", reason: (err as Error).message });
    return { action: "denied", reason: "error" };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal.test`
Expected: PASS (all six cases).

- [ ] **Step 5: Export + commit**

Add to `index.ts`: `runJournal`, `type JournalConfig`, `type JournalDeps`, `type JournalOutcome`.

```bash
git add packages/core/src/journal.ts packages/core/src/__tests__/journal.test.ts packages/core/src/index.ts
git commit -m "feat(core): journal orchestrator — select/generate/screen/draft/post (#67 P12 slice 6)"
```

---

### Task 7: Config reader + run-end loop hook + docs

**Files:**
- Create: `packages/core/src/journal-config.ts`
- Create: `packages/core/src/__tests__/journal-config.test.ts`
- Modify: `packages/core/src/loop.ts` (run-end hook in `finally`)
- Modify: `packages/core/src/journal.ts` (the live `maybeJournal` wrapper that builds real deps)
- Modify: `packages/core/src/index.ts`
- Modify: `README.md`, `docs/ARCHITECTURE.md`

**Interfaces:**
- Produces:
  - `journal-config.ts`: `function readJournalConfig(workspaceDir: string): JournalConfig | null` — reads `.otto/config.json` `journal` block; absent/`enabled:false`/malformed → `null`. Applies defaults (`autonomous:false`, `categories:["gotcha","dead-end"]`, `minDaysBetweenPosts:1`). Autonomous requires BOTH config `autonomous:true` AND `OTTO_JOURNAL_AUTONOMOUS=1` (pass env in).
  - `journal.ts`: `async function maybeJournal(args: { workspaceDir; packageDir; iteration; maxRetries; agentId; signal? }): Promise<void>` — builds real `JournalDeps` (generate via `executeStage(STAGES.journalWrite)`, judge via `executeStage(STAGES.journalScreen)` parsing `<journal-verdict>SAFE</journal-verdict>`, publish via `createThreadsClient(resolveThreadsAuth())`, repoIdentifiers via git, secretPatterns via `readSafetyPolicy`), reads config, calls `runJournal`. Never throws.

- [ ] **Step 1: Write the failing config test**

Create `packages/core/src/__tests__/journal-config.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournalConfig } from "../journal-config.js";

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "otto-jcfg-")); mkdirSync(join(ws, ".otto"), { recursive: true }); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));
const write = (o: unknown) => writeFileSync(join(ws, ".otto", "config.json"), JSON.stringify(o));

it("returns null when there is no journal block", () => {
  write({ branchStrategy: "branch" });
  expect(readJournalConfig(ws, {})).toBeNull();
});
it("returns null when enabled is false", () => {
  write({ journal: { enabled: false } });
  expect(readJournalConfig(ws, {})).toBeNull();
});
it("applies defaults when enabled", () => {
  write({ journal: { enabled: true } });
  expect(readJournalConfig(ws, {})).toMatchObject({ enabled: true, autonomous: false, categories: ["gotcha", "dead-end"], minDaysBetweenPosts: 1 });
});
it("requires BOTH config.autonomous and the env flag to be autonomous", () => {
  write({ journal: { enabled: true, autonomous: true } });
  expect(readJournalConfig(ws, {})?.autonomous).toBe(false);
  expect(readJournalConfig(ws, { OTTO_JOURNAL_AUTONOMOUS: "1" })?.autonomous).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-config`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `journal-config.ts`**

```ts
/** Read the per-repo journal opt-in from .otto/config.json (issue #67 P12). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalConfig } from "./journal.js";

export function readJournalConfig(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env
): JournalConfig | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(workspaceDir, ".otto", "config.json"), "utf8"));
  } catch {
    return null;
  }
  const j = raw.journal as Record<string, unknown> | undefined;
  if (!j || j.enabled !== true) return null;
  const envAutonomous = ["1", "true", "yes", "on"].includes(
    (env.OTTO_JOURNAL_AUTONOMOUS ?? "").trim().toLowerCase()
  );
  return {
    enabled: true,
    autonomous: j.autonomous === true && envAutonomous,
    categories: Array.isArray(j.categories)
      ? (j.categories as unknown[]).filter((c): c is string => typeof c === "string")
      : ["gotcha", "dead-end"],
    minDaysBetweenPosts:
      typeof j.minDaysBetweenPosts === "number" ? j.minDaysBetweenPosts : 1,
  };
}
```

- [ ] **Step 4: Run the config test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- journal-config`
Expected: PASS.

- [ ] **Step 5: Implement `maybeJournal` (live deps) in `journal.ts`**

Append to `journal.ts` — the harness wrapper that wires real generation/judge/publish:

```ts
import { executeStage } from "./stage-exec.js";
import { STAGES } from "./stages.js";
import { readSafetyPolicy } from "./safety-policy.js";
import { createThreadsClient, resolveThreadsAuth } from "./threads-api.js";
import { readJournalConfig } from "./journal-config.js";
import { git } from "./git.js";
import { basename } from "node:path";
import type { AgentRuntimeId } from "./agent-runtime.js";

/** Collect this repo's own identifiers so the gate can deny self-references. */
function repoIdentifiers(workspaceDir: string): string[] {
  const ids = new Set<string>([basename(workspaceDir)]);
  const remote = git(["remote", "get-url", "origin"], workspaceDir);
  if (remote) {
    for (const part of remote.split(/[/:@.]/)) {
      if (part.length >= 3 && !["https", "http", "git", "com", "org", "www"].includes(part)) {
        ids.add(part);
      }
    }
  }
  return [...ids];
}

function parseVerdict(result: string): boolean {
  return /<journal-verdict>\s*SAFE\s*<\/journal-verdict>/i.test(result);
}

/** Harness run-end hook: builds real deps and runs the journal. Never throws. */
export async function maybeJournal(args: {
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  agentId: AgentRuntimeId;
  signal?: AbortSignal;
}): Promise<JournalOutcome> {
  try {
    const config = readJournalConfig(args.workspaceDir);
    if (!config) return { action: "disabled" };

    const stageArgs = {
      workspaceDir: args.workspaceDir,
      packageDir: args.packageDir,
      iteration: args.iteration,
      maxRetries: args.maxRetries,
      agentId: args.agentId,
      signal: args.signal,
    };
    const auth = config.autonomous ? resolveThreadsAuth() : null;
    const client = auth ? createThreadsClient(auth) : undefined;

    return await runJournal(args.workspaceDir, config, {
      generate: async (learning) =>
        (await executeStage({ ...stageArgs, stage: STAGES.journalWrite, vars: { INPUTS: learning, RESUME: "" }, logLabel: "journal-write" })).result,
      judge: async (note) =>
        parseVerdict((await executeStage({ ...stageArgs, stage: STAGES.journalScreen, vars: { INPUTS: note, RESUME: "" }, logLabel: "journal-screen" })).result),
      publish: client ? (text) => client.publish(text) : undefined,
      repoIdentifiers: repoIdentifiers(args.workspaceDir),
      secretPatterns: readSafetyPolicy(args.workspaceDir).secretPatterns,
      now: () => new Date(),
    });
  } catch {
    return { action: "denied", reason: "hook-error" };
  }
}
```

- [ ] **Step 6: Wire the hook into `runLoop`'s `finally`**

In `packages/core/src/loop.ts`, inside the `finally` block (after `releaseOnce();`), add a guarded call. Import `maybeJournal` at the top (`import { maybeJournal } from "./journal.js";`). The hook only runs when not aborted; it is a no-op when the journal is disabled:

```ts
    if (!activeSignal.aborted) {
      try {
        await maybeJournal({
          workspaceDir,
          packageDir,
          iteration: completedIterations || 1,
          maxRetries,
          agentId: activeAgentId,
          signal: activeSignal,
        });
      } catch {
        // the journal must never affect a run's outcome.
      }
    }
```

(Confirm the in-scope names on this branch: `workspaceDir`, `packageDir`, `maxRetries`, `activeAgentId`, `activeSignal`, `completedIterations` are all live in `runLoop`.)

- [ ] **Step 7: Add a loop no-op test**

Add to `packages/core/src/__tests__/loop.test.ts` a case asserting a normal run with no `.otto/config.json` journal block creates no `.otto/journal` dir (the hook is a no-op). Use the existing loop harness (mocked `runStage` returns the sentinel); after `runLoop`, assert `existsSync(join(workspaceDir, ".otto", "journal"))` is false.

Run: `pnpm --filter @phamvuhoang/otto-core test -- loop`
Expected: PASS.

- [ ] **Step 8: Docs**

- `README.md`: extend the capability line — Otto can keep an opt-in, secrecy-filtered public **journal** (Threads), off by default.
- `docs/ARCHITECTURE.md`: add a "Public journal (P12)" section — the run-end hook, the three-gate default-deny secrecy filter, privilege separation (agent produces text; harness gates + posts), draft-default vs autonomous double opt-in, and the `.otto/journal/` layout (drafts, audit.log, posted.json). Add module-map rows for `journal-gate.ts`, `journal-source.ts`, `journal-ledger.ts`, `threads-api.ts`, `journal.ts`, `journal-config.ts`.

- [ ] **Step 9: Full verify + commit**

Run: `pnpm -r typecheck && pnpm -r test && pnpm test`
Expected: PASS.

```bash
git add packages/core/src/journal-config.ts packages/core/src/__tests__/journal-config.test.ts \
  packages/core/src/journal.ts packages/core/src/loop.ts packages/core/src/index.ts \
  packages/core/src/__tests__/loop.test.ts README.md docs/ARCHITECTURE.md
git commit -m "feat(core): journal config + run-end loop hook + docs (#67 P12 slice 7)"
```

---

## Self-Review

**Spec coverage:**
- Layered default-deny gate (3 gates) → Tasks 1, 2, 5/6 ✓; `secretPatterns` wired → Task 1 ✓; audit trail → Task 1 ✓.
- Memory-sourced, generalized entries → Task 4 (`selectCandidate`, `forbiddenTermsFor`) + Task 5 (`journal-write.md`) ✓.
- Threads live pipeline → Task 3 ✓; draft-default / autonomous double opt-in → Tasks 6 + 7 (`readJournalConfig`) ✓.
- Cadence/dedup → Task 4 (ledger) ✓. Privilege separation → Task 6/7 (agent only generates/judges; harness gates + posts) ✓.
- Run-end in-loop hook, off by default → Task 7 ✓. Config opt-in → Task 7 ✓.

**Placeholder scan:** No TBD/TODO. Soft spots, called out: Task 5 stage `tier` is conditional on the branch (`Stage.tier` may not exist on `main`); Task 7 Step 6 placement depends on the live `runLoop` scope (names listed to confirm). The `journal-ledger.ts` snippet notes the unused `appendFileSync` import to drop.

**Type consistency:** `GateContext` (with `repoIdentifiers`/`secretPatterns`/`forbiddenTerms`), `GateResult`, `screenEntry`, `Gate3Judge`, `JournalConfig`, `JournalDeps`, `JournalOutcome`/`JournalAction`, `PostedEntry`, `ThreadsClient`/`ThreadsAuth` are used identically across tasks. `forbiddenTermsFor` (Task 4) feeds `GateContext.forbiddenTerms` (Task 2) in `runJournal` (Task 6). `readJournalConfig` returns the `JournalConfig` defined in Task 6.

**Verification:** every task ends green on the scoped vitest; full `pnpm -r typecheck && pnpm -r test && pnpm test` at Task 7.
