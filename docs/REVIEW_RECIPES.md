# `otto-review` recipes — matching review depth to the PR

Copy-pasteable `otto-review` invocations for the situations that come up most,
plus the two settings that decide what a review costs. Full flag reference:
**[docs/CLI.md](./CLI.md#otto-review--automated-pull-request-code-review)**.

## What a review costs

Every review runs a pool of read-only **lenses** over the exact `base...head`
revision, then one adversarial **verify** pass that tries to refute what the
lenses found. So the cost of a run is roughly `(number of lenses) + 1` agent
invocations — a 3-line typo fix and a 3000-line refactor pay the same unless
you say otherwise.

Two flags change that:

- **`--lenses <list>`** — run a subset instead of all five.
- **`--model-routing`** — resolve each stage to a model tier instead of running
  everything on the runtime default model.

| Lens          | Routed tier | What it looks for                                         |
| ------------- | ----------- | --------------------------------------------------------- |
| `correctness` | mid         | Logic defects, edge cases, error handling                 |
| `security`    | strong      | Injection, authz, secret handling, unsafe deserialization |
| `tests`       | cheap       | Missing/weak coverage for the change                      |
| `structural`  | strong      | Architecture, coupling, blast radius, scope drift         |
| `task-fit`    | mid         | Does the diff do what the spec/issue actually asked       |

The verify pass is always strong-tier. Tiers resolve through the ladder
`cheap=haiku, mid=sonnet, strong=opus`, overridable per tier with
`OTTO_TIER_CHEAP` / `OTTO_TIER_MID` / `OTTO_TIER_STRONG`.

`--lenses` is validated against that catalogue: an unknown name exits 1 and
names the valid lenses, and the selection is normalized to the canonical order
above regardless of how you type it.

## Recipes

### Quick triage of a small PR — cheapest useful review

```bash
otto-review --repo owner/name --pr 123 --lenses correctness,tests --model-routing --output markdown
```

Two lenses instead of five, and `tests` runs on the cheap tier.

### Security-focused pass on a dependency or auth change

```bash
otto-review --repo owner/name --pr 123 --lenses security,structural --model-routing --output markdown
```

Both lenses are strong-tier, so this keeps the expensive model where it earns
its cost and skips the three lenses you don't need.

### Maximum-depth review of a hard PR

```bash
OTTO_TIER_STRONG=fable otto-review --repo owner/name --pr 123 --model-routing --output markdown
```

All five lenses; the strong tier resolves to your most capable model while
`tests` still runs cheap.

### Spec-conformance check — does the PR do what the issue asked?

```bash
otto-review --repo owner/name --pr 123 --spec-issue 456 \
  --lenses task-fit,correctness --model-routing --output markdown
```

`task-fit` is the lens that reads the attached spec; pairing it with
`correctness` keeps it honest without paying for security/structural.

### Cheap always-on daemon over labelled PRs

```bash
otto-review --repo owner/name --watch --lenses correctness,tests \
  --model-routing --budget 5 --detach --notify
```

Reviews every open, non-draft PR carrying the `otto-review` label and publishes
a comment. `--budget` is a hard USD ceiling for the invocation.

### Deep daemon for a security-sensitive repo

```bash
OTTO_TIER_STRONG=fable otto-review --repo owner/name --watch \
  --github-review --model-routing --budget 25 --detach
```

All five lenses plus a formal GitHub review verdict
(`APPROVE`/`COMMENT`/`REQUEST_CHANGES`).

### Escalate — re-review the same PR harder

```bash
# cheap first pass
otto-review --repo owner/name --pr 123 --lenses correctness,tests --output markdown
# full pass — actually re-runs, does not replay the two-lens result
otto-review --repo owner/name --pr 123 --model-routing --output markdown
```

A review is identified by `(repository, pull request, head SHA, review-input
fingerprint)`, and a repeat invocation normally short-circuits at zero cost.
The lens set is recorded alongside that identity and checked before any reuse,
so asking for a **different** lens set always runs a real review instead of
handing back the cheaper one.

## Gotchas

- **`--output text` is a summary only** — outcome plus severity counts, no
  per-finding detail. Use **`--output markdown`** to actually read the
  findings locally. (`--output comment` publishes to the PR.)
- **A model pin disables routing.** If `OTTO_MODEL` or `OTTO_CLAUDE_MODEL` is
  set, the pin wins and `--model-routing` is silently inert. Unset it for the
  recipes above.
- **`--lenses`, `--model-routing`, and `--token-mode` are invocation-only** —
  no environment variable, no `.otto/config.json` equivalent — so a `--detach`
  daemon needs them on the command line. In particular `OTTO_REVIEW_LENSES` is
  **not** read here: it means something different for `otto-afk` (setting it
  implies `--review-panel`), and inheriting it would silently change review
  behavior.
- **`--token-mode reduce` saves almost nothing.** It compacts trailing
  whitespace and collapses blank-line runs; it is not a substitute for
  `--lenses`/`--model-routing`.
- **`--context-compressor headroom` compresses the PR body only** — never the
  diff and never the `review-input.md` artifact, both of which are retained
  byte-for-byte as evidence.
- **Publication needs the label; local output does not.** The `otto-review`
  label gates GitHub posting. A one-shot `--output text`/`markdown` run works
  on an unlabelled PR.
- **`otto-review` runs need the native `fs-ext` addon built** for its OS-flock
  lease. It is an optional, lazily-loaded dependency — install and every other
  command work without it.
