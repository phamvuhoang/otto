# Plan — Add caching to the product API

## Problem

The product listing endpoint is slow, so we will add caching.

## File map

- `src/api/products.ts`
- `src/cache.ts`

## Tasks

1. Add an in-memory cache helper in `src/cache.ts`.
2. Call the cache from the listing handler in `src/api/products.ts`.
3. Make sure responses are faster.
