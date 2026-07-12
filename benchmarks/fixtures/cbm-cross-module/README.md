# Fixture: cbm-cross-module (P26)

Measures whether an agent surfaces a **buried cross-module impact** when it has
codebase-memory (CBM) retrieval available versus not — the eval question
behind `impactRecall` in `packages/core/src/eval.ts`.

## The buried dependency

- `src/a.ts` defines `MAX_RETRIES`/`shouldRetry`, the sync pipeline's retry
  policy.
- `src/shared.ts` re-exports `shouldRetry` as `canRetry` — a barrel
  indirection.
- `src/b.ts` imports `canRetry` from `./shared.ts`, **never** from `./a.ts`
  directly.

So a change to `a.ts` changes `b.ts`'s behavior, but a naive text search for
"who imports a.ts" misses `b.ts` entirely — the dependency is only visible to
something that resolves the re-export chain (an import-graph-aware index, or a
codebase-memory tool built on one).

## Known impact

`impact.json` lists the two files a correct answer should name when asked
"what does changing `src/a.ts` impact?": `src/a.ts` itself and `src/b.ts`.
`scoreImpactRecall(knownImpactedFiles, answerText)` (in `eval.ts`) scores an
agent's answer against this list — 1.0 if both paths appear in the answer
text, 0.5 if only one does.

## Running the A/B (gated, not CI)

This fixture's real signal — does `--enable-tool codebase-memory` (the
`cbm-on` config in `benchmarks/configs.json`) raise `impactRecall` versus
`cbm-off` on this task — requires an actual model run and is **not** part of
the CI suite (matching `input-sharpening`/`verification-coverage`). The
CI-runnable half is the pure `scoreImpactRecall` unit test in
`packages/core/src/__tests__/cbm-eval-signals.test.ts`.
