# Issue #43 plan — Safety policy and taint tracking

Each slice is one commit. Substrate slices are INERT (exported from `index.ts`,
wired into no bin/loop) so they cannot regress a live run. Default policy is
permissive, so trusted local plan/PRD workflows keep working (metric #3).

- [x] **1. Policy substrate `safety-policy.ts`** — `SafetyPolicy` type,
      permissive `DEFAULT_POLICY`, pure `parseSafetyPolicy(raw)` (never throws,
      malformed → defaults), `readSafetyPolicy(workspaceDir)` reading
      `.otto/policy.json`. Export from `index.ts`. Pinned by
      `safety-policy.test.ts`. INERT.
- [x] **2. Policy-evaluation predicates** — pure `checkCommand`/`checkWritePath`/
      `checkNetworkDomain`/`checkApprovalRequired` returning a `PolicyViolation[]`
      (empty under `DEFAULT_POLICY`). INERT.
- [ ] **3. Taint substrate `taint.ts`** — `TaintSource` taxonomy (issue-body,
      comment, review-doc, web-content, command-output, model-memory) +
      `wrapUntrusted(content, source)` fencing content in a labelled block with
      the standard untrusted-content warning. INERT.
- [ ] **4. Surface taint in prompts** — wrap untrusted inputs (issue body/
      comments/review docs/spill output) with the warning in the templates;
      render-contract test.
- [ ] **5. Safety events in trajectories + eval** — `SafetyEvent` in
      `run-report.ts` (manifest/stage), scored by `eval.ts`.
- [ ] **6. Policy checks at the boundary** — wire policy evaluation around
      shell/`@spill` tags + stage execution (first non-inert slice; default
      policy permissive → trusted workflows unchanged).
- [ ] **7. Docs** — README (Why Otto bullet + policy.json example), ARCHITECTURE
      (module-map rows + a Safety policy & taint section), a policy.json field
      reference.
