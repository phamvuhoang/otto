# Structural Code-Quality Review (P14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structural-quality review lens and a severity-ranked, cost-routed review panel so Otto catches codebase decay it misses today, at lower review cost.

**Architecture:** A new pure module `review-severity.ts` owns the finding wire-format, severity ranking, nit-suppression, and cross-lens dedup. The `structural` lens is a new `templates/lens-guidance/structural.md` injected into the existing `review-lens.md` via the renderer's `@include` tag. `panel.ts` is extended to route which lenses run (reusing `risk.ts`), resolve a per-lens model tier (reusing `model-tier.ts`), dedupe findings before verify, run lenses in bounded-concurrency parallel, and early-exit when no findings survive. Severity flows through `review-verify.md` and `review-synth.md`, and synth annotates its commit with the findings it fixed.

**Tech Stack:** TypeScript (NodeNext ESM, relative imports end in `.js`), vitest (`vitest run`), the existing `render.ts` template renderer, `risk.ts` classifier, `model-tier.ts` ladder.

## Global Constraints

- **ESM only.** Every relative import in `packages/core/src/` ends in `.js`.
- **Verify command (every task):** `pnpm -r typecheck && pnpm -r test` from repo root.
- **Tests live in** `packages/core/src/__tests__/<name>.test.ts`; import the unit under test from `../<name>.js`.
- **Templates ship in the tarball** under `packages/core/templates/`; render them in tests via `renderTemplate(absPath, vars, { cwd, spillHostDir, spillRefPath })`.
- **Additive / opt-in.** A default `--review-panel` run with no new flags keeps today's behavior; the legacy single reviewer (`review.md`) is untouched.
- **No refactoring beyond the change** (`.claude/CLAUDE.md` §3 Surgical Changes).
- **Commit style:** Conventional Commits; do not add `Co-Authored-By` to `fix(review):` commits.

---

### Task 1: Severity model, finding parser, ranking, nit-suppression

**Files:**
- Create: `packages/core/src/review-severity.ts`
- Test: `packages/core/src/__tests__/review-severity.test.ts`

**Interfaces:**
- Consumes: nothing (pure, leaf module).
- Produces:
  - `type Severity = "blocker" | "major" | "minor" | "nit"`
  - `type Finding = { severity: Severity; file: string; line?: string; claim: string; why: string; suggestedFix?: string; lens?: string }`
  - `parseFindings(text: string, lens?: string): { findings: Finding[]; dropped: number }`
  - `rankFindings(findings: Finding[]): Finding[]`
  - `suppressLowValue(findings: Finding[]): { kept: Finding[]; suppressed: number }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/review-severity.test.ts
import { describe, expect, it } from "vitest";
import {
  parseFindings,
  rankFindings,
  suppressLowValue,
  type Finding,
} from "../review-severity.js";

describe("parseFindings", () => {
  it("parses pipe-delimited findings and tags the lens", () => {
    const text = [
      "Some prose the model wrote first.",
      "BLOCKER | src/loop.ts:120-180 | gate+routing+cost in one block | three responsibilities, hard to scan | extract resolveGate()",
      "nit | src/util.ts:4 | unused import | dead code |",
    ].join("\n");
    const { findings, dropped } = parseFindings(text, "structural");
    expect(dropped).toBe(0);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual<Finding>({
      severity: "blocker",
      file: "src/loop.ts",
      line: "120-180",
      claim: "gate+routing+cost in one block",
      why: "three responsibilities, hard to scan",
      suggestedFix: "extract resolveGate()",
      lens: "structural",
    });
    expect(findings[1].suggestedFix).toBeUndefined();
  });

  it("drops malformed lines instead of throwing", () => {
    const { findings, dropped } = parseFindings("MAYBE | only two fields");
    expect(findings).toHaveLength(0);
    expect(dropped).toBe(1);
  });
});

describe("rankFindings", () => {
  it("orders blocker→major→minor→nit, stable within a tier", () => {
    const fs: Finding[] = [
      { severity: "nit", file: "a", claim: "a", why: "" },
      { severity: "blocker", file: "b", claim: "b", why: "" },
      { severity: "minor", file: "c", claim: "c", why: "" },
      { severity: "blocker", file: "d", claim: "d", why: "" },
    ];
    expect(rankFindings(fs).map((f) => f.file)).toEqual(["b", "d", "c", "a"]);
  });
});

describe("suppressLowValue", () => {
  it("drops nits when a blocker or major exists", () => {
    const fs: Finding[] = [
      { severity: "blocker", file: "a", claim: "a", why: "" },
      { severity: "nit", file: "b", claim: "b", why: "" },
      { severity: "nit", file: "c", claim: "c", why: "" },
    ];
    const { kept, suppressed } = suppressLowValue(fs);
    expect(kept.map((f) => f.severity)).toEqual(["blocker"]);
    expect(suppressed).toBe(2);
  });

  it("keeps everything when no blocker/major present", () => {
    const fs: Finding[] = [
      { severity: "minor", file: "a", claim: "a", why: "" },
      { severity: "nit", file: "b", claim: "b", why: "" },
    ];
    const { kept, suppressed } = suppressLowValue(fs);
    expect(kept).toHaveLength(2);
    expect(suppressed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-severity`
Expected: FAIL — `Cannot find module '../review-severity.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/review-severity.ts
/**
 * Severity model + structured-finding plumbing for the review panel (P14).
 * Pure — no I/O. Lenses and the verifier emit pipe-delimited finding lines;
 * this module parses, ranks, dedupes, and applies the nit-suppression rule.
 */

export type Severity = "blocker" | "major" | "minor" | "nit";

export type Finding = {
  severity: Severity;
  file: string;
  line?: string;
  claim: string;
  why: string;
  suggestedFix?: string;
  lens?: string;
};

const ORDER: Severity[] = ["blocker", "major", "minor", "nit"];
const RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

function asSeverity(token: string): Severity | null {
  const t = token.trim().toLowerCase();
  return (ORDER as string[]).includes(t) ? (t as Severity) : null;
}

/** Wire format, one finding per line: `SEVERITY | file:line | claim | why | fix?`
 *  `file:line` may be just `file`; the trailing `fix` field is optional. A line
 *  that does not yield a valid severity + ≥4 fields is dropped (counted). */
export function parseFindings(
  text: string,
  lens?: string
): { findings: Finding[]; dropped: number } {
  const findings: Finding[] = [];
  let dropped = 0;
  for (const raw of text.split("\n")) {
    if (!raw.includes("|")) continue;
    const parts = raw.split("|").map((p) => p.trim());
    const severity = asSeverity(parts[0]);
    if (!severity || parts.length < 4) {
      if (severity || /^(blocker|major|minor|nit)\b/i.test(raw.trim())) dropped++;
      continue;
    }
    const [fileRaw, claim, why] = [parts[1], parts[2], parts[3]];
    const fix = parts[4]?.length ? parts[4] : undefined;
    const m = fileRaw.match(/^(.*?):(\d+(?:-\d+)?)$/);
    const file = m ? m[1] : fileRaw;
    const line = m ? m[2] : undefined;
    findings.push({ severity, file, line, claim, why, suggestedFix: fix, lens });
  }
  return { findings, dropped };
}

/** Stable sort by severity (blocker first); input order preserved within a tier. */
export function rankFindings(findings: Finding[]): Finding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}

/** Cursor output hierarchy: if any blocker/major exists, drop nits so synth and
 *  the report stay high-signal. Minors are kept (they are cheap and often real). */
export function suppressLowValue(findings: Finding[]): {
  kept: Finding[];
  suppressed: number;
} {
  const hasHigh = findings.some(
    (f) => f.severity === "blocker" || f.severity === "major"
  );
  if (!hasHigh) return { kept: findings, suppressed: 0 };
  const kept = findings.filter((f) => f.severity !== "nit");
  return { kept, suppressed: findings.length - kept.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-severity`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/review-severity.ts packages/core/src/__tests__/review-severity.test.ts
git commit -m "feat(review): severity model, finding parser, ranking, nit-suppression"
```

---

### Task 2: Cross-lens dedup

**Files:**
- Modify: `packages/core/src/review-severity.ts`
- Test: `packages/core/src/__tests__/review-severity.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `Finding`, `Severity` from Task 1.
- Produces: `dedupeFindings(findings: Finding[]): Finding[]`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/__tests__/review-severity.test.ts
import { dedupeFindings } from "../review-severity.js";

describe("dedupeFindings", () => {
  it("merges same file+overlapping range, keeps highest severity, unions lenses", () => {
    const fs: Finding[] = [
      { severity: "minor", file: "src/a.ts", line: "10-20", claim: "leaky", why: "w1", lens: "correctness" },
      { severity: "major", file: "src/a.ts", line: "15", claim: "leaky", why: "w2", lens: "structural" },
    ];
    const out = dedupeFindings(fs);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("major");
    expect(out[0].lens).toBe("correctness, structural");
    expect(out[0].why).toContain("w1");
    expect(out[0].why).toContain("w2");
  });

  it("keeps findings in different files or non-overlapping ranges separate", () => {
    const fs: Finding[] = [
      { severity: "minor", file: "src/a.ts", line: "10", claim: "x", why: "" },
      { severity: "minor", file: "src/b.ts", line: "10", claim: "x", why: "" },
      { severity: "minor", file: "src/a.ts", line: "99", claim: "x", why: "" },
    ];
    expect(dedupeFindings(fs)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-severity`
Expected: FAIL — `dedupeFindings is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/core/src/review-severity.ts
function range(line?: string): [number, number] | null {
  if (!line) return null;
  const m = line.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const lo = Number(m[1]);
  return [lo, m[2] ? Number(m[2]) : lo];
}

function overlaps(a?: string, b?: string): boolean {
  const ra = range(a);
  const rb = range(b);
  if (!ra || !rb) return a === b; // no parsable range → exact-string match
  return ra[0] <= rb[1] && rb[0] <= ra[1];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Merge findings pointing at the same place: same file, overlapping line range,
 *  and the same normalized claim. Keeps the highest severity, unions the raising
 *  lenses (comma-joined, de-duped, sorted), and concatenates distinct why-text. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const hit = out.find(
      (g) =>
        g.file === f.file &&
        norm(g.claim) === norm(f.claim) &&
        overlaps(g.line, f.line)
    );
    if (!hit) {
      out.push({ ...f });
      continue;
    }
    if (RANK[f.severity] < RANK[hit.severity]) hit.severity = f.severity;
    const lenses = new Set(
      [hit.lens, f.lens].filter(Boolean).flatMap((l) => l!.split(", "))
    );
    hit.lens = [...lenses].sort().join(", ") || undefined;
    if (f.why && !hit.why.includes(f.why))
      hit.why = hit.why ? `${hit.why}; ${f.why}` : f.why;
  }
  return out;
}
```

(`RANK` is already defined in Task 1; reuse it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-severity`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/review-severity.ts packages/core/src/__tests__/review-severity.test.ts
git commit -m "feat(review): cross-lens finding dedup by file+range+claim"
```

---

### Task 3: Structural lens guidance template + `@include` wiring

**Files:**
- Create: `packages/core/templates/lens-guidance/structural.md`
- Create: `packages/core/templates/lens-guidance/correctness.md` (empty guard), `security.md`, `tests.md`, `task-fit.md` (empty guards)
- Modify: `packages/core/templates/review-lens.md` (add one `@include` line + severity wire-format instruction)
- Test: `packages/core/src/__tests__/review-lens.test.ts` (add a describe block)

**Interfaces:**
- Consumes: the renderer's `@include:<path>` tag (relative to the template dir).
- Produces: a `structural` lens whose rendered output contains the seven structural standards and the severity wire format; existing lenses render unchanged.

**Why empty guards:** `@include:lens-guidance/{{ LENS }}.md` fails the iteration if the file is absent. Ship an empty (or one-line) guidance file for each existing lens so the include always resolves.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/__tests__/review-lens.test.ts
describe("structural lens (P14)", () => {
  it("injects the seven structural standards for LENS=structural", () => {
    const out = render("structural");
    expect(out).toContain("# REVIEWER — structural lens");
    expect(out).toMatch(/code judo|structural simplification/i);
    expect(out).toMatch(/1,?000 lines/);
    expect(out).toMatch(/spaghetti|ad-hoc conditional/i);
  });

  it("instructs every lens to emit the severity wire format", () => {
    const out = render("correctness");
    expect(out).toMatch(/SEVERITY \| file:line \| claim \| why \| fix/);
    expect(out).toMatch(/blocker.*major.*minor.*nit/i);
  });

  it("renders existing lenses without structural guidance leaking in", () => {
    const out = render("tests");
    expect(out).not.toMatch(/code judo/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-lens`
Expected: FAIL — structural header / wire-format assertions not met.

- [ ] **Step 3: Write the guidance files and wire the include**

Create `packages/core/templates/lens-guidance/structural.md`:

```markdown
## Structural-quality standards (this lens only)

You defend codebase health. Beyond "does it work", ask: **did this change leave
the codebase messier?** Hold the change to these seven standards (aligned with
`.claude/CLAUDE.md` Simplicity First + Surgical Changes):

1. **Structural simplification ("code judo").** Is there a reframing that makes
   whole branches, helpers, modes, conditionals, or layers disappear? If 200
   lines could be 50, that is a finding.
2. **File-size control.** Flag a file pushed past ~1,000 lines without strong
   justification; prefer extracting helpers/subcomponents.
3. **Spaghetti prevention.** Reject ad-hoc conditionals scattered through
   unrelated flows; demand a dedicated abstraction instead.
4. **Design over acceptance.** Do not rubber-stamp an "it works" implementation
   that leaves the codebase harder to scan or more coupled.
5. **Type cleanliness.** Question unnecessary optionality and casts; prefer
   explicit typed models over loosely-shaped objects.
6. **Canonical layers.** Flag feature logic leaking into shared paths; reuse the
   existing utility/home instead of a parallel one.
7. **Orchestration simplicity.** Flag needless sequential flows where parallel
   execution is clearer and less brittle.

**Output hierarchy:** structural regressions first, then missed simplifications,
then spaghetti growth, then boundary/file-size/legibility. Do not raise nits when
a blocker or major exists. You **flag only** — never edit or commit.
```

Create empty guards (one line each is fine), e.g. `packages/core/templates/lens-guidance/correctness.md`:

```markdown
<!-- correctness lens: definition lives in review-lens.md; no extra guidance -->
```

(Repeat identically for `security.md`, `tests.md`, `task-fit.md`.)

In `packages/core/templates/review-lens.md`, add near the top (after the `# REVIEWER — {{ LENS }} lens` header):

```markdown
@include:lens-guidance/{{ LENS }}.md
```

and add a findings-format section the four built-in lens definitions share:

```markdown
## How to report findings

Emit each finding on its own line, pipe-delimited:

`SEVERITY | file:line | claim | why | fix?`

- `SEVERITY` is one of `blocker | major | minor | nit`.
- `file:line` may be `path` or `path:line` or `path:start-end`.
- `fix` (a one-line remediation hint) is optional.

Example:
`major | packages/core/src/loop.ts:120-180 | gate+routing+cost in one block | three responsibilities, hard to scan | extract resolveGate()`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-lens`
Expected: PASS (existing task-fit tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/templates/lens-guidance packages/core/templates/review-lens.md packages/core/src/__tests__/review-lens.test.ts
git commit -m "feat(review): structural lens guidance + severity wire format"
```

---

### Task 4: Severity-aware verify + synth templates

**Files:**
- Modify: `packages/core/templates/review-verify.md`
- Modify: `packages/core/templates/review-synth.md`
- Test: `packages/core/src/__tests__/review-templates-severity.test.ts` (new)

**Interfaces:**
- Consumes: the merged findings file (Task 7) and the severity wire format (Task 3).
- Produces: verifier verdicts carrying severity with downgrade; synth that fixes in severity order, suppresses nits, and annotates its commit.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/review-templates-severity.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../templates/${rel}`, import.meta.url)), "utf8");

describe("review-verify severity contract", () => {
  it("requires verdicts to carry a severity and allows downgrade", () => {
    const t = read("review-verify.md");
    expect(t).toMatch(/CONFIRMED <severity>/);
    expect(t).toMatch(/downgrade/i);
  });
});

describe("review-synth severity contract", () => {
  it("fixes in severity order and suppresses nits when blockers/majors exist", () => {
    const t = read("review-synth.md");
    expect(t).toMatch(/severity order|highest severity first/i);
    expect(t).toMatch(/suppress|skip nits/i);
  });

  it("annotates the commit body with the findings addressed", () => {
    const t = read("review-synth.md");
    expect(t).toMatch(/Addressed:/);
    expect(t).toMatch(/file:line/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-templates-severity`
Expected: FAIL — strings not present in templates.

- [ ] **Step 3: Edit the templates**

In `review-verify.md`, change the verdict-format instruction to:

```markdown
Write each verdict on its own line, carrying severity (you MAY **downgrade** a
finding's severity if it is real but smaller than claimed):

- `CONFIRMED <severity> | file:line | claim | why this is really a problem`
- `REJECTED | file:line | claim | why this is not a real problem`

`<severity>` is one of `blocker | major | minor | nit`. Stay biased toward
REJECTED for anything you cannot substantiate — a false positive costs more than
a missed nit.
```

In `review-synth.md`, change the fix instructions to:

```markdown
Apply confirmed findings **highest severity first** (blocker → major → minor).
**Suppress nits**: if any blocker or major is confirmed, skip nit-severity
findings entirely — do not spend a fix on them while real issues remain.

When you commit, annotate the body with what you fixed:

```
fix(review): <short summary>

Addressed:
- blocker | path/file.ts:120 | <claim>
- major   | path/other.ts:8  | <claim>
Suppressed N nit(s).
```

Still one `fix(review):` commit, CONFIRMED-only, no refactoring beyond the fix.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-templates-severity`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/templates/review-verify.md packages/core/templates/review-synth.md packages/core/src/__tests__/review-templates-severity.test.ts
git commit -m "feat(review): severity-aware verify verdicts and synth fix ordering"
```

---

### Task 5: Risk-routed lens selection (include `structural`)

**Files:**
- Modify: `packages/core/src/risk.ts:137` (`selectLenses`) and the available-lens pool
- Test: `packages/core/src/__tests__/risk-lens-routing.test.ts` (new)

**Interfaces:**
- Consumes: `classifyRisk`, `ReviewDepth`, `selectLenses(depth, available)` (existing).
- Produces: `selectLenses` returns `structural` only at `panel` depth (high risk); docs-only/test-only stays without it. Pure — `panel.ts` wiring to actually run the routed subset is Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/risk-lens-routing.test.ts
import { describe, expect, it } from "vitest";
import { classifyRisk, reviewDepthForLevel, selectLenses } from "../risk.js";

const POOL = ["correctness", "security", "tests", "task-fit", "structural"];

describe("structural lens routing", () => {
  it("runs structural at panel depth (high-risk, cross-module change)", () => {
    const lenses = selectLenses("panel", POOL);
    expect(lenses).toContain("structural");
  });

  it("omits structural at lenses depth (medium risk)", () => {
    expect(selectLenses("lenses", POOL)).not.toContain("structural");
  });

  it("a docs-only change does not reach panel depth", () => {
    const depth = reviewDepthForLevel(classifyRisk(["README.md", "docs/x.md"]).level);
    expect(depth).not.toBe("panel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- risk-lens-routing`
Expected: FAIL — `selectLenses("panel", POOL)` does not yet include `structural`.

- [ ] **Step 3: Implement**

In `risk.ts`, update `selectLenses` so the `panel` case returns the full available pool **including** `structural`, and the `lenses` case returns the medium subset **excluding** `structural` and `security`. Concretely, the `panel` branch should pass through every lens in `available` (preserving order); the `lenses` branch filters to `["correctness", "tests", "task-fit"]` intersected with `available`. Leave `single` → `[]`.

```ts
export function selectLenses(depth: ReviewDepth, available: string[]): string[] {
  switch (depth) {
    case "single":
      return [];
    case "lenses": {
      const medium = ["correctness", "tests", "task-fit"];
      return available.filter((l) => medium.includes(l));
    }
    case "panel":
      return [...available];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- risk-lens-routing` then the full suite `pnpm -r test` (an existing `risk` test may pin the old `lenses` subset — update it to match the new medium subset if so).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/risk.ts packages/core/src/__tests__/risk-lens-routing.test.ts
git commit -m "feat(review): route structural lens to high-risk changes only"
```

---

### Task 6: Per-lens model-tier routing

**Files:**
- Modify: `packages/core/src/model-tier.ts`
- Test: `packages/core/src/__tests__/lens-tier.test.ts` (new)

**Interfaces:**
- Consumes: `ModelTier` (existing).
- Produces:
  - `LENS_TIER: Record<string, ModelTier>`
  - `tierForLens(lens: string): ModelTier` (default `"mid"`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/lens-tier.test.ts
import { describe, expect, it } from "vitest";
import { tierForLens } from "../model-tier.js";

describe("tierForLens", () => {
  it("routes structural and security to the strong tier", () => {
    expect(tierForLens("structural")).toBe("strong");
    expect(tierForLens("security")).toBe("strong");
  });
  it("routes mechanical lenses cheaper", () => {
    expect(tierForLens("tests")).toBe("cheap");
    expect(tierForLens("correctness")).toBe("mid");
  });
  it("defaults unknown lenses to mid", () => {
    expect(tierForLens("custom-thing")).toBe("mid");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- lens-tier`
Expected: FAIL — `tierForLens is not a function`.

- [ ] **Step 3: Implement**

```ts
// add to packages/core/src/model-tier.ts
/** Base model tier per review lens (P14). Structural/security reasoning gets the
 *  strong tier; mechanical lenses run cheaper. Pin (OTTO_MODEL/OTTO_CLAUDE_MODEL)
 *  and failure-escalation still take precedence in resolveStageModel/routeModel. */
export const LENS_TIER: Record<string, ModelTier> = {
  structural: "strong",
  security: "strong",
  correctness: "mid",
  "task-fit": "mid",
  tests: "cheap",
};

export function tierForLens(lens: string): ModelTier {
  return LENS_TIER[lens] ?? "mid";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- lens-tier`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/model-tier.ts packages/core/src/__tests__/lens-tier.test.ts
git commit -m "feat(review): per-lens model-tier map"
```

---

### Task 7: Wire panel — routed subset, per-lens tier, dedupe, parallel, early-exit

**Files:**
- Modify: `packages/core/src/panel.ts` (lens loop `panel.ts:175-205`, verify gate, synth gate)
- Test: `packages/core/src/__tests__/panel-wiring.test.ts` (new — unit-test the extracted helpers)

**Interfaces:**
- Consumes: `parseFindings`, `dedupeFindings`, `rankFindings` (Tasks 1–2); `tierForLens` (Task 6); `selectLenses`/`classifyRisk` (Task 5).
- Produces: two extracted pure helpers so the wiring is testable without spawning agents:
  - `routedLenses(changedPaths: string[], available: string[], adaptiveRouter: boolean): string[]`
  - `mergeLensFindings(files: { lens: string; text: string }[]): { findings: import("./review-severity.js").Finding[]; total: number }`

**Why extract helpers:** `runPanel` spawns real sub-agents and is integration-heavy. Pull the routing + merge decisions into pure functions in `panel.ts` (exported) and unit-test those; keep the agent orchestration thin.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/panel-wiring.test.ts
import { describe, expect, it } from "vitest";
import { routedLenses, mergeLensFindings } from "../panel.js";

describe("routedLenses", () => {
  it("returns the full pool when the adaptive router is off", () => {
    const pool = ["correctness", "security", "tests", "task-fit", "structural"];
    expect(routedLenses(["src/loop.ts"], pool, false)).toEqual(pool);
  });
  it("drops structural for a docs-only change when routing is on", () => {
    const pool = ["correctness", "security", "tests", "task-fit", "structural"];
    expect(routedLenses(["README.md"], pool, true)).not.toContain("structural");
  });
});

describe("mergeLensFindings", () => {
  it("parses, tags lens, and dedupes across lens files", () => {
    const files = [
      { lens: "correctness", text: "minor | src/a.ts:10-20 | leaky | w1 |" },
      { lens: "structural", text: "major | src/a.ts:15 | leaky | w2 |" },
    ];
    const { findings, total } = mergeLensFindings(files);
    expect(total).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("major");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- panel-wiring`
Expected: FAIL — helpers not exported from `panel.js`.

- [ ] **Step 3: Implement the helpers and wire them in**

Add to `panel.ts`:

```ts
import { classifyRisk, reviewDepthForLevel, selectLenses } from "./risk.js";
import {
  parseFindings,
  dedupeFindings,
  type Finding,
} from "./review-severity.js";
import { tierForLens } from "./model-tier.js";

/** Which lenses actually run this iteration. Router off → the full configured
 *  pool (today's behavior). Router on → risk-routed subset (Task 5). */
export function routedLenses(
  changedPaths: string[],
  available: string[],
  adaptiveRouter: boolean
): string[] {
  if (!adaptiveRouter) return [...available];
  const depth = reviewDepthForLevel(classifyRisk(changedPaths).level);
  const routed = selectLenses(depth, available);
  return routed.length ? routed : [...available];
}

/** Parse every lens's findings file, tag with its lens, and dedupe across lenses
 *  so the verifier sees each issue once. `total` is the pre-dedupe count. */
export function mergeLensFindings(
  files: { lens: string; text: string }[]
): { findings: Finding[]; total: number } {
  const all: Finding[] = [];
  for (const { lens, text } of files) all.push(...parseFindings(text, lens).findings);
  return { findings: dedupeFindings(all), total: all.length };
}
```

Then, inside `runPanel`:

1. Replace `lenses` with `routedLenses(changedPaths, opts.lenses, adaptiveRouter)` at the top of the run (thread `changedPaths` and an `adaptiveRouter` boolean through `RunPanelOptions`; default `adaptiveRouter=false` keeps current behavior).
2. When building each lens stage, pass the per-lens tier: resolve the stage's effective model with `tierForLens(lens)` as the base tier (route it through the existing `resolveStageModel`/`executeStage` model path the same way stage `tier` is resolved).
3. Convert the sequential lens `for` loop (`panel.ts:176`) to bounded-concurrency parallel execution (reuse the fan-out concurrency cap). Collect results, then `recordStage` in lens-index order so evidence stays deterministic.
4. After lenses, build the merged findings file from the in-memory results via `mergeLensFindings`, write it to `panelHostDir` as `findings-merged.md`, and point the verifier at it.
5. **Early-exit:** if `mergeLensFindings(...).findings.length === 0`, skip verify + synth and return the clean `<review>OK</review>` result.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- panel-wiring` then full `pnpm -r test`.
Expected: PASS; no regression in existing panel tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/panel.ts packages/core/src/__tests__/panel-wiring.test.ts
git commit -m "feat(review): route lenses by risk, per-lens tier, dedupe, parallel, early-exit"
```

---

### Task 8: Finding→commit trace + evidence severity counts

**Files:**
- Modify: `packages/core/src/run-report.ts` (add severity counts to the stage/manifest record)
- Modify: `packages/core/src/panel.ts` (compute counts from merged findings, pass to `recordStage`)
- Test: `packages/core/src/__tests__/review-severity.test.ts` (add a `severityCounts` block) and `packages/core/src/__tests__/run-report.test.ts` (assert counts persist — extend the existing test if present, else create)

**Interfaces:**
- Consumes: `Finding`, `suppressLowValue` (Task 1).
- Produces: `severityCounts(findings: Finding[]): Record<Severity, number> & { suppressed: number }` in `review-severity.ts`; a `reviewSeverity` field on the panel's stage record.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/src/__tests__/review-severity.test.ts
import { severityCounts } from "../review-severity.js";

describe("severityCounts", () => {
  it("tallies by severity and reports suppressed nits", () => {
    const fs: Finding[] = [
      { severity: "blocker", file: "a", claim: "a", why: "" },
      { severity: "nit", file: "b", claim: "b", why: "" },
      { severity: "nit", file: "c", claim: "c", why: "" },
    ];
    const c = severityCounts(fs);
    expect(c.blocker).toBe(1);
    expect(c.nit).toBe(2);
    expect(c.suppressed).toBe(2); // both nits suppressed because a blocker exists
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-severity`
Expected: FAIL — `severityCounts is not a function`.

- [ ] **Step 3: Implement**

```ts
// append to packages/core/src/review-severity.ts
export function severityCounts(
  findings: Finding[]
): Record<Severity, number> & { suppressed: number } {
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0, suppressed: 0 };
  for (const f of findings) counts[f.severity]++;
  counts.suppressed = suppressLowValue(findings).suppressed;
  return counts;
}
```

In `panel.ts`, after `mergeLensFindings`, compute `severityCounts(findings)` and pass it through `recordStage` for the verify/synth record (add an optional `reviewSeverity?` field to the `StageRecord` type in `run-report.ts`, written when present). The synth commit annotation (Task 4 template) already carries the per-finding `Addressed:` trace; this step records the machine-readable counts alongside it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @phamvuhoang/otto-core test -- review-severity` then full `pnpm -r typecheck && pnpm -r test`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/review-severity.ts packages/core/src/panel.ts packages/core/src/run-report.ts packages/core/src/__tests__/
git commit -m "feat(review): record finding severity counts in the evidence bundle"
```

---

## Self-Review

**Spec coverage:** A1 severity model → Task 1; A1 dedup → Task 2; A2 structural lens → Task 3; A3 verify/synth → Task 4; B1 risk-routed lenses → Task 5; B2 per-lens tier → Task 6; B3 dedup wiring + B4 parallel/early-exit → Task 7; finding→commit trace + evidence counts → Tasks 4 (commit annotation) + 8 (counts). All spec sections map to a task.

**Placeholder scan:** No TBD/TODO; every code step shows real code; commands are exact.

**Type consistency:** `Finding`/`Severity` defined in Task 1 and reused unchanged in Tasks 2, 7, 8. `tierForLens`/`LENS_TIER` (Task 6) used by name in Task 7. `routedLenses`/`mergeLensFindings` (Task 7) signatures match their tests. `selectLenses` signature unchanged from `risk.ts`.

**Note for the implementer:** Task 7 step 3 touches the agent-orchestration core of `panel.ts`; keep the pure helpers (`routedLenses`, `mergeLensFindings`) exactly as tested and treat the in-`runPanel` wiring as plumbing around them. If the existing `risk` test pins the old `lenses` subset, update it (Task 5 step 4).
