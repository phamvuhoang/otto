# Token Consumption Reduction Implementation Plan

> **For agentic workers:** Implement task-by-task. Use checkbox (`- [ ]`) syntax for tracking. Do not enable token reduction by default.

**Goal:** Give Otto users visibility into Claude token consumption and add an opt-in mode that reduces repeated prompt/token cost without weakening implementation or review correctness.

**User request:** "reduce token consumption" with:

- show token consumption
- add a parameter to activate token consumption reduction
- reference `messkan/prompt-cache` or other best practices

**Recommended product shape:** add one parameter: `--token-mode <off|measure|reduce>` with env fallback `OTTO_TOKEN_MODE`.

- `off` = current behavior; no extra console output.
- `measure` = parse and show actual token usage from Claude `stream-json` result events; no prompt changes.
- `reduce` = show token usage and enable conservative prompt reduction/caching.

This avoids two competing booleans (`--show-tokens` + `--reduce-tokens`) and gives users a safe measurement-only mode before behavior changes.

**Splitting pattern applied:** Simple/Complex + Defer Performance.

- Start with exact token measurement because it is low risk and uses existing `result` event plumbing.
- Add the CLI activation parameter next.
- Only then add reduction logic, keeping the first reduction slice conservative.
- Defer semantic caching of agent outputs entirely; for Otto, cached implementer/reviewer results are unsafe because repo state changes between runs.

**Reference behavior from PromptCache:** PromptCache uses semantic matching, high/low thresholds, a gray-zone verifier, runtime config, stats, and cache warming. Otto should borrow the safety posture and observability, but not cache code-mutating agent results. Use exact-hash caching first for read-only derived prompt artifacts; semantic matching can be a later spike if needed. Reference: https://github.com/messkan/prompt-cache

**Existing architecture to reuse:**

- `packages/core/src/runner.ts` already parses `result`, `total_cost_usd`, `is_error`, and `api_error_status` in `resultFromEvent()`.
- `packages/core/src/loop.ts` already centralizes per-stage accounting in `accountStage()`.
- `packages/core/src/cli-help.ts` already owns flag parsing, help text, and `--print-config`.
- `packages/core/src/run-bin.ts` already threads parsed flags into `runLoop()`.
- `packages/core/templates/*.md` already spill large dynamic context such as full diffs and issue bodies.

---

## Epic User Story

**As a** maintainer running long Otto AFK loops  
**I want to** see how many tokens each stage consumes and optionally reduce repeated prompt/context tokens  
**so that** I can control cost and latency without making the agent less reliable.

**Epic acceptance criteria:**

- Given I run Otto with default flags, when a loop runs, then behavior and output remain effectively unchanged.
- Given I run Otto with `--token-mode measure`, when each stage completes, then Otto prints actual input/output/cache token usage and an end-of-run token summary.
- Given I run Otto with `--token-mode reduce`, when each stage runs, then Otto uses only conservative prompt reductions/caches and still prints actual token usage.
- Given I run `--print-config`, when `OTTO_TOKEN_MODE` or `--token-mode` is set, then the resolved token mode is visible.
- Given a Claude result event omits `usage`, when Otto parses it, then the run succeeds with zero-token defaults.

---

## File Structure

- **Modify** `packages/core/src/runner.ts` - parse token usage from Claude `result` events.
- **Modify** `packages/core/src/loop.ts` - aggregate and optionally print token usage.
- **Modify** `packages/core/src/cli-help.ts` - parse `--token-mode`, document `OTTO_TOKEN_MODE`, show in `--print-config`.
- **Modify** `packages/core/src/run-bin.ts` - resolve token mode and pass it to `runLoop()` / watch mode.
- **Modify** `packages/core/src/watch.ts` - forward token mode into loop invocations if watch already forwards budget/cooldown/review settings.
- **New** `packages/core/src/tokens.ts` - pure token usage types, parsing helpers, formatting, aggregation, and token-mode validation.
- **New** `packages/core/src/prompt-reduction.ts` - conservative prompt reduction/cache helpers for `reduce` mode.
- **Modify** `packages/core/src/stage-exec.ts` - apply prompt reduction after `renderTemplate()` and before `runStage()`.
- **Modify** tests under `packages/core/src/__tests__/`.
- **Modify** `README.md`, `docs/CONFIG.md`, `docs/ARCHITECTURE.md`.

---

## Task 0: Token Usage Discovery Spike

**Purpose:** Confirm the exact shape of Claude Code `stream-json` `result.usage` events in this repo before hardening the parser.

- [ ] Inspect recent `.otto-tmp/logs/*.ndjson` files and capture 2-3 `type: "result"` examples: success, rate limit/error if available, and a cache-hit/cache-read case if available.
- [ ] Document the observed token fields in this plan or a short note near the parser. Expected fields from existing local docs include `input_tokens`, `output_tokens`, and cache-related input token fields.
- [ ] Decide which fields count toward "total consumed" for display. Recommended:
  - `inputTokens`
  - `outputTokens`
  - `cacheCreationInputTokens`
  - `cacheReadInputTokens`
  - `totalTokens = input + output + cacheCreation + cacheRead`
- [ ] Decide whether cached-read tokens are displayed separately from billable/effective tokens. Recommended: show them separately; do not pretend they cost the same as fresh input tokens.

**Acceptance criteria:**

- Given a real NDJSON fixture with `usage`, when parsed by the planned helper, then all known fields are mapped.
- Given an older result event without `usage`, when parsed, then all token fields default to `0`.

---

## Task 1: Parse Token Usage From Result Events

**User story:**  
**As a** maintainer  
**I want to** collect actual token usage from the Claude result event  
**so that** token reporting is based on provider truth rather than estimates.

**Implementation steps:**

- [ ] Add `TokenUsage`, `emptyTokenUsage()`, `parseTokenUsage(ev: unknown)`, `addTokenUsage(a, b)`, and `formatTokenUsage()` to `packages/core/src/tokens.ts`.
- [ ] Extend `StageResult` in `packages/core/src/runner.ts`:
  - `usage: TokenUsage`
- [ ] Update `resultFromEvent()` to parse `usage` safely.
- [ ] Keep cost/error behavior unchanged.
- [ ] Update every test helper that returns `StageResult` to include `usage`, preferably through a shared helper like `ok(result, costUsd, usage?)`.

**Acceptance criteria:**

- **Scenario:** result event includes usage
- **Given:** a `result` event with `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, and `usage.cache_read_input_tokens`
- **When:** `resultFromEvent()` parses it
- **Then:** `StageResult.usage` contains those numbers

- **Scenario:** result event omits usage
- **Given:** an old or malformed result event
- **When:** `resultFromEvent()` parses it
- **Then:** `StageResult.usage` is all zeros and no exception is thrown

**Tests:**

- [ ] Extend `packages/core/src/__tests__/runner.test.ts` for full usage parsing.
- [ ] Add malformed values coverage: strings, negative numbers, `null`.
- [ ] Ensure existing result/cost/error tests still pass.

---

## Task 2: Add `--token-mode` / `OTTO_TOKEN_MODE`

**User story:**  
**As a** maintainer  
**I want to** opt into token visibility or token reduction explicitly  
**so that** default AFK behavior stays stable.

**Implementation steps:**

- [ ] Add `type TokenMode = "off" | "measure" | "reduce"` in `tokens.ts`.
- [ ] Add `parseTokenMode(raw: string | undefined): TokenMode`:
  - unset/empty = `off`
  - valid = `off`, `measure`, `reduce`
  - invalid CLI value throws with a clear error
  - invalid env value should be reported by `--print-config` and fail real runs rather than silently falling back
- [ ] Extend `CliFlags` with `tokenMode?: TokenMode`.
- [ ] Parse `--token-mode <off|measure|reduce>` in `parseFlags()`.
- [ ] Resolve final token mode in `run-bin.ts`: CLI flag wins over `OTTO_TOKEN_MODE`, then default `off`.
- [ ] Add `tokenMode?: TokenMode` to `LoopOptions`.
- [ ] Thread token mode into `runLoop()`.
- [ ] Thread token mode through `runWatch()` if watch mode invokes `runLoop()` internally.
- [ ] Add `token mode` to `printConfig()`.
- [ ] Add help text and environment variable docs.

**Acceptance criteria:**

- **Scenario:** default mode
- **Given:** no `--token-mode` and no `OTTO_TOKEN_MODE`
- **When:** I run `otto-afk --print-config`
- **Then:** config shows `token mode off`

- **Scenario:** CLI flag wins
- **Given:** `OTTO_TOKEN_MODE=measure`
- **When:** I run `otto-afk --token-mode reduce --print-config`
- **Then:** config shows `token mode reduce`

- **Scenario:** invalid mode
- **Given:** `--token-mode aggressive`
- **When:** I run any Otto bin
- **Then:** parsing fails before Claude is invoked

**Tests:**

- [ ] `cli-help.test.ts`: parses each valid mode.
- [ ] `cli-help.test.ts`: rejects invalid mode and missing value.
- [ ] `run-bin` or print-config tests: env fallback and CLI precedence.

---

## Task 3: Show Token Consumption

**User story:**  
**As a** maintainer  
**I want to** see token usage per stage and per run  
**so that** I can identify expensive prompts and stages.

**Implementation steps:**

- [ ] In `loop.ts`, add `runTokenUsage = emptyTokenUsage()`.
- [ ] In `accountStage(sr)`, aggregate `sr.usage` into `runTokenUsage`.
- [ ] If token mode is `measure` or `reduce`, print one concise per-stage line after the cost line:
  - example: `tokens in 7,739 | out 569 | cache create 0 | cache read 103,036 | run total 111,344`
- [ ] Update `summarize()` to include token totals when token mode is not `off`.
- [ ] Return token usage in `LoopOutcome` if useful for watch-mode budgeting/reporting.
- [ ] Keep output unchanged when token mode is `off`.

**Acceptance criteria:**

- **Scenario:** measure mode shows stage usage
- **Given:** `runStage()` returns usage
- **When:** `runLoop()` runs with `tokenMode: "measure"`
- **Then:** stderr contains a per-stage token line and stdout summary contains run totals

- **Scenario:** off mode is quiet
- **Given:** `runStage()` returns usage
- **When:** `runLoop()` runs with `tokenMode: "off"`
- **Then:** stdout/stderr snapshots do not include token usage lines

**Tests:**

- [ ] `loop.test.ts`: measure mode prints per-stage and summary totals.
- [ ] `loop.test.ts`: off mode preserves old summary output.
- [ ] `panel.test.ts`: panel sub-agents count tokens once per lens/verifier/synth through existing `onStage`.

---

## Task 4: Establish a Safe Reduction Policy

**User story:**  
**As a** maintainer  
**I want to** know exactly what token reduction is allowed to change  
**so that** the feature does not trade correctness for cost.

**Policy to encode in code comments and docs:**

- [ ] Do not cache final implementer, reviewer, verifier, or synth agent results.
- [ ] Do not skip reading required task inputs, diffs, issue bodies, or review docs.
- [ ] Do not summarize source/diff context with an LLM and hide the original from the agent.
- [ ] Do cache only read-only derived artifacts whose source hash is known.
- [ ] Prefer exact-hash cache hits in MVP. Defer semantic similarity cache to a later spike.
- [ ] Keep full original context available by spill file or direct path.
- [ ] Treat semantic cache practices from PromptCache as future guidance: high threshold = direct hit, low threshold = miss, gray zone = verifier. Do not ship gray-zone behavior until there is a correctness harness.

**Acceptance criteria:**

- Given `--token-mode reduce`, when prompt reduction runs, then the agent still has a path to full original context.
- Given a source hash changes, when a cached artifact exists for the old hash, then Otto does not reuse it.
- Given a code-mutating stage result exists from a prior run, when a similar prompt appears, then Otto never replays that result.

---

## Task 5: Add Conservative Prompt Reduction

**User story:**  
**As a** maintainer running repeated iterations  
**I want to** reduce repeated stable prompt/context tokens  
**so that** later stages are cheaper while retaining the same information access.

**Implementation steps:**

- [ ] Create `packages/core/src/prompt-reduction.ts` with:
  - `applyPromptReduction(prompt, opts): ReducedPrompt`
  - `ReducedPrompt.prompt`
  - `ReducedPrompt.stats` with `originalChars`, `reducedChars`, `cacheHits`, `cacheMisses`
- [ ] Apply it in `stage-exec.ts` after `renderTemplate()` and before `runStage()` only when token mode is `reduce`.
- [ ] Log a concise reduction line in reduce mode:
  - example: `prompt reduce 48.2k -> 31.4k chars | cache hits 2`
- [ ] Start with safe transformations only:
  - collapse excessive blank lines in rendered prompts
  - cap repeated boilerplate sections only when exact duplicate blocks occur in the same prompt
  - replace large known dynamic blocks with a summary plus a full-context file path only when the full source is already available via spill/path
- [ ] Preserve all XML-ish section markers used by templates.
- [ ] Add fixture tests for every template class: `afk`, `ghafk`, `linearafk`, `review`, `verify`, `apply-review`, `review-panel` templates.

**Acceptance criteria:**

- **Scenario:** reduce mode transforms prompt
- **Given:** a rendered prompt with duplicate stable blocks
- **When:** `applyPromptReduction()` runs
- **Then:** the reduced prompt is shorter and contains a note explaining what was collapsed

- **Scenario:** full context remains reachable
- **Given:** a prompt section is reduced
- **When:** the reduced prompt is inspected
- **Then:** it includes the path or instruction needed to read the full original context

- **Scenario:** off/measure modes do not transform prompt
- **Given:** `tokenMode` is `off` or `measure`
- **When:** `executeStage()` runs
- **Then:** the rendered prompt passed to `runStage()` is byte-for-byte unchanged

**Tests:**

- [ ] Unit tests for `applyPromptReduction()`.
- [ ] `stage-exec.test.ts`: reduction applies only for `reduce`.
- [ ] Template render smoke remains green.

---

## Task 6: Add Exact-Hash Prompt Artifact Cache

**User story:**  
**As a** maintainer  
**I want to** reuse derived summaries of unchanged prompt artifacts  
**so that** repeated review/issue/diff context costs less across iterations.

**Implementation steps:**

- [ ] Add a gitignored workspace cache directory, recommended `.otto/token-cache/`.
- [ ] Ensure `.otto/token-cache/` is listed in `.gitignore` during setup, similar to `.otto/state.json`.
- [ ] Store cache metadata as JSON:
  - source kind: `diff`, `issues`, `learnings`, `review-doc`, etc.
  - source hash
  - reducer version
  - createdAt
  - summary file path
- [ ] Do not store raw prompt text unless necessary. If summaries can contain sensitive repo data, document that the cache is local and gitignored.
- [ ] For MVP, generate deterministic host-side summaries only:
  - diff: commit SHA, files changed, insertions/deletions, top-level touched areas
  - issues: issue number/title/labels, body length/comment count, not full bodies
  - learnings: heading index and byte size
- [ ] Reuse a cached summary only when source hash and reducer version match exactly.
- [ ] Add cache stats to the reduction line: hits/misses/writes.

**Acceptance criteria:**

- **Scenario:** exact cache hit
- **Given:** the same diff source hash appears in a later iteration
- **When:** reduce mode runs
- **Then:** Otto reuses the cached deterministic summary

- **Scenario:** source changed
- **Given:** the diff source hash changes
- **When:** reduce mode runs
- **Then:** Otto misses the cache and writes a new summary

- **Scenario:** cache is local-only
- **Given:** `.otto/token-cache/` exists
- **When:** `git status --porcelain` runs
- **Then:** cache contents do not appear as tracked or untracked changes

**Tests:**

- [ ] Unit tests for cache key hashing and version invalidation.
- [ ] Unit tests for cache hit/miss/write counters.
- [ ] Integration-style test with a temporary git workspace proving `.gitignore` behavior.

---

## Task 7: Improve Prompt Layout for Provider Prompt Caching

**User story:**  
**As a** maintainer  
**I want to** maximize provider-side prompt cache reuse for stable instructions  
**so that** repeated iterations benefit from cached prompt prefixes when Claude supports it.

**Implementation steps:**

- [ ] Audit templates for stable vs volatile content.
- [ ] Prefer stable instructions before volatile content where behavior remains equivalent:
  - stable: playbooks such as `prompt.md`, `ghprompt.md`, reviewer instructions
  - volatile: resume note, git logs, learnings, issue lists, latest diff
- [ ] If reordering a template is risky, create a reduced-mode variant instead of changing default behavior.
- [ ] Keep section names explicit so the playbook can still reference dynamic blocks.
- [ ] Use measured `cache_read_input_tokens` / `cache_creation_input_tokens` from Task 1 to validate whether layout changes improve provider cache reuse.

**Acceptance criteria:**

- Given repeated `--token-mode reduce` runs with similar static instructions, when Claude reports cache usage, then cache-read/cache-creation tokens are displayed.
- Given template order changes, when template tests run, then no required tags or includes are lost.
- Given default token mode is `off`, when templates are rendered, then default behavior remains intentionally reviewed and documented.

**Tests:**

- [ ] Template include tests updated for any reordering.
- [ ] Snapshot or fixture tests showing reduced-mode prompt shape.
- [ ] Manual smoke comparing token usage before/after on the same small plan.

---

## Task 8: Documentation and UX

**User story:**  
**As a** maintainer  
**I want to** understand token modes and their safety limits  
**so that** I can choose the right cost-control setting.

**Implementation steps:**

- [ ] Update `README.md` flags table:
  - `--token-mode <off|measure|reduce>`
  - examples for measuring a run and enabling reduction
- [ ] Update `docs/CONFIG.md` environment variable table:
  - `OTTO_TOKEN_MODE`
- [ ] Update `docs/ARCHITECTURE.md`:
  - result-event token parsing
  - token accounting location
  - reduction mode safety policy
  - cache directory and gitignore behavior
- [ ] Add troubleshooting note:
  - token counts are actual post-stage usage, not preflight estimates
  - cache-read tokens may not equal billable tokens
  - reduction mode is conservative and may show small gains on tiny prompts

**Acceptance criteria:**

- Given a new user reads README, when they want token visibility only, then they can find `--token-mode measure`.
- Given a user wants behavior unchanged, when they read docs, then they know default mode is `off`.
- Given a user wants aggressive semantic caching, when they read docs, then they understand it is intentionally out of MVP scope.

---

## Task 9: Verification Plan

Run from repo root unless noted.

- [ ] `pnpm --filter @phamvuhoang/otto-core test -- runner`
- [ ] `pnpm --filter @phamvuhoang/otto-core test -- cli-help`
- [ ] `pnpm --filter @phamvuhoang/otto-core test -- loop`
- [ ] `pnpm -r typecheck`
- [ ] `pnpm -r test`
- [ ] `pnpm test`
- [ ] `pnpm -r build`
- [ ] Smoke:
  - `otto-afk --token-mode measure --print-config`
  - `OTTO_TOKEN_MODE=reduce otto-afk --print-config`
  - one tiny one-iteration `otto-afk --token-mode measure "<plan>" 1` in a disposable repo

**Success metrics:**

- Token measurement adds no behavior change in `off` mode.
- `measure` mode prints per-stage and total tokens.
- `reduce` mode never hides full source context from the agent.
- Repeated runs expose cache-read/cache-create fields when Claude reports them.
- Unit and integration tests cover missing/malformed usage fields.

---

## Deprioritized / Follow-Up Work

- [ ] Semantic similarity cache for read-only summaries using embeddings, high/low thresholds, and gray-zone verifier.
- [ ] Token budget stop condition, e.g. `--token-budget <tokens>`.
- [ ] Provider-specific billable-token estimation.
- [ ] Web dashboard or long-run token trend report.
- [ ] Cache warming from historical prompt/result pairs. Only consider for read-only artifacts, not code-mutating agent actions.

---

## INVEST Check

- **Independent:** measurement can ship before reduction; reduction can ship before semantic caching.
- **Negotiable:** exact display format and reducer internals can be refined during implementation.
- **Valuable:** users get direct cost visibility and an opt-in reduction path.
- **Estimable:** each task maps to known files and tests.
- **Small:** Tasks 1-3 are small vertical slices; Tasks 5-7 can be split further if estimates exceed 3-5 days.
- **Testable:** each task has concrete parser, CLI, loop, prompt, or docs acceptance criteria.
