# Fixture: cbm-dynamic-fallback (P26 slice 2)

Measures whether codebase-memory's retrieval correctly **defers to raw
search** when the caller graph can't resolve a call site — dynamic dispatch
being the case a static import/reference graph structurally cannot answer,
as distinct from `cbm-cross-module`'s buried-but-_statically-resolvable_
barrel re-export.

## The dynamic dispatch

- `registry.mjs`'s `dispatch(eventType, payload)` looks up the handler as
  `handlers[\`handle${capitalize(eventType)}\`]` — a **computed property
  access**, not a named import or a direct call.
- `handlers.mjs` exports `handleOrder`, `handlePayment`, and (once the
  benchmark task lands) `handleRefund`.
- Nothing in the source text statically says `dispatch("refund", ...)` calls
  `handleRefund` — that link only exists by evaluating the string
  `"handle" + capitalize("refund")` at runtime.

A graph-based index built from imports/exports/call sites sees `registry.mjs`
import `handlers.mjs` as a module, but has no edge from `dispatch`'s call
site to any specific handler function. Asked "what handles a refund event?",
a retrieval strategy that only walks the graph will either return nothing or
guess wrong; the correct behavior is to **fall back to raw text search** (e.g.
grepping for `handleRefund` or the `handle${capitalize(...)}` pattern) once
the graph comes back empty for the call site.

## Pass condition

Add a `handleRefund(payload)` export to `handlers.mjs` returning
`{ orderId: payload.orderId, refunded: payload.amount }`, so
`dispatch("refund", payload)` resolves it. `node --test` is green once the
new handler exists and both the dynamic dispatch and the existing handlers
still work (see `handlers.test.mjs`).

## Running the paid suite

Registered in `benchmarks/suite.json` with `"args": ["--enable-tool",
"codebase-memory"]` and `"env": { "OTTO_CBM_E2E": "1" }` on the task itself,
matching the `cbm-inject`/`cbm-on` configs in `benchmarks/configs.json` so the
tool is active under every config that also sets those. As with the rest of
the benchmark suite (`benchmarks/README.md`), this fixture's real signal —
does codebase-memory's retrieval correctly fall back to raw search instead of
mis-resolving (or silently dropping) the dynamic call site — requires an
actual model run and is **not** part of CI; it is validated in CI only
structurally (the fixture exists, the suite entry has a well-formed
expectation, `node --test` fails on the unfixed tree and passes once
`handleRefund` lands).

**Model-dependent outcome:** whether codebase-memory actually falls back to
raw search (rather than mis-resolving or omitting the dynamic call site)
depends on the model under test and is not guaranteed by the fixture alone —
the fixture only guarantees the underlying property (a call site the graph
cannot statically resolve) exists to be found.
