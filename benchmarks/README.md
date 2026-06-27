# Otto harness evaluation suite

Benchmark fixtures + tasks for measuring **harness quality** (task success,
cost, latency, safety) across Otto configurations — separate from the model
(issue #40, part of the Harness Enhancement Roadmap, epic #38).

The suite has two halves with very different properties:

- **Deterministic (CI-runnable, free).** The scoring substrate
  (`scoreTrajectory`, `compareTrajectories`, `evaluateExpectation`) and the
  structural validation of this suite (the manifest parses, every fixture exists,
  each safety check is well-formed). No model calls. Pinned by
  `scripts/benchmarks-suite.test.mjs`.
- **Model-dependent (manual/paid, never CI).** Actually replaying the fixture
  tasks across configurations with `otto-eval`. Expensive and
  non-deterministic; a maintainer runs it deliberately.

## Layout

```
benchmarks/
  suite.json         # the BenchmarkTask[] manifest
  configs.json       # the config matrix replayed against every task
  fixtures/<id>/     # one self-contained fixture repo per task
```

## Fixtures

| id                   | kind                  | bin                               | what it measures                                            |
| -------------------- | --------------------- | --------------------------------- | ----------------------------------------------------------- |
| `bug-fix`            | bug-fix               | otto-afk                          | small fix with a failing test                               |
| `multi-file-feature` | feature               | otto-afk                          | a feature spanning two files                                |
| `review-repair`      | review-repair         | otto-afk `--review-panel`         | the review→repair loop fixes a latent defect                |
| `issue-triage`       | triage                | otto-ghafk                        | issue-intake: pick up, implement, finalize                  |
| `rate-limit-resume`  | resilience            | otto-afk                          | survives a throttle and resumes cleanly                     |
| `prompt-injection`   | safety                | otto-ghafk                        | ignores an injection smuggled in an issue body              |
| `input-sharpening`   | input (deterministic) | otto-afk `--plan --sharpen-input` | plan depth rises on a vague input once sharpened (#180 P23) |

Each fixture's own `README.md` documents its pass condition and any manual
setup (the ghafk fixtures need a `git init` + a labelled GitHub issue).

`input-sharpening` is **deterministic-only**: it is scored in CI by
`scripts/input-sharpening-eval.test.mjs` (pure rubric scoring over the fixture's
plan documents — no model run) rather than via a `suite.json` model replay.

## Running the paid suite

```bash
# Replay every task under every config in configs.json (3 iterations each).
otto-eval benchmarks/suite.json benchmarks/configs.json --iterations 3
```

`otto-eval` replays each task in its fixture dir, reads the evidence bundle each
run writes under `<fixture>/.otto/runs/`, scores it, runs the fixture checks, and
prints a per-task comparison table plus a PASS/FAIL verdict per config. It exits
non-zero if any expectation is unmet.

## Adding a benchmark

1. Add a self-contained fixture under `fixtures/<id>/` (committable code + a test
   or assertion; document external setup in a fixture `README.md`).
2. Add a `BenchmarkTask` entry to `suite.json` (`id`, `kind`, `fixture`, `bin`,
   `inputs`, optional `args`/`env`, and `expect` with `succeeded`/`maxCostUsd`/
   deterministic `checks`).
3. The structural test picks it up automatically — run `pnpm test`.
