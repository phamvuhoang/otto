# Plan — Add caching to the product API

## Problem

The product listing endpoint recomputes its response on every request and is slow
under load; users see multi-second list pages. Caching the computed listing
removes the repeated work.

## Decisions

No human was available during planning, so each gap the input left open is
recorded here as an explicit assumption (question → assumption → rationale) for a
reviewer to accept or correct:

- **Constraints?** → Assume an in-process cache with a 60-second TTL and **no new
  dependency** (no Redis). → Rationale: the repo has no cache service today;
  in-process is the simplest viable option (YAGNI) and avoids new infra.
- **Success criteria?** → Assume done-when: a second identical request inside the
  TTL is served from cache without recomputing, pinned by a test. → Rationale: a
  cache hit is the observable behavior the change exists to produce.
- **Non-goals?** → Assume a distributed/shared cache and write-through
  invalidation are out of scope. → Rationale: keeps the slice small and testable;
  they are separate follow-ups.

## Scope guard

Non-goals: a distributed/Redis cache, cross-instance sharing, and write-through
invalidation on product updates. This slice is a single in-process read cache.

## File map

- `src/cache.ts`
- `src/api/products.ts`
- `src/__tests__/cache.test.ts`

## Tasks

1. **Cache helper.** Write a failing test in `src/__tests__/cache.test.ts` that
   pins: a second `get(key)` within the TTL returns the stored value without
   re-invoking the loader; watch it fail, then implement `src/cache.ts`.
   verify: `node --test`
2. **Wire into the listing handler.** Write a failing test in
   `src/__tests__/products.test.ts` asserting the listing loader runs once across
   two requests inside the TTL; watch it fail, then call the cache in
   `src/api/products.ts`. verify: `node --test`

## Testing notes

Testable success criteria (done when): within the 60s TTL a repeated listing
request is served from cache — the loader is invoked once across two requests —
asserted by a test in `src/__tests__/products.test.ts`; `node --test` passes.
