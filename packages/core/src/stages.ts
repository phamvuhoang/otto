export type Stage = {
  name: string;
  template: string;
  permissionMode?: string;
};

// Every stage runs `claude --permission-mode bypassPermissions` so bash + edits
// auto-approve for non-interactive AFK. Blast radius is bounded by the runner
// (see resolveRunner in runner.ts): the default `sandbox` runner confines writes
// to the workspace via the native OS sandbox; `OTTO_RUNNER=host` runs unsandboxed
// (git-recoverable workspace only). See the spec under docs/superpowers/specs/.
export const STAGES = {
  // Authors a spec + plan (no implementation) for human review before code
  // (issue #63 P8). Registered here; wiring it into a chain is a later slice.
  plan: {
    name: "plan",
    template: "plan.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  implementer: {
    name: "implementer",
    template: "afk.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  ghafkImplementer: {
    name: "ghafk-implementer",
    template: "ghafk.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  ghafkIssueImplementer: {
    name: "ghafk-issue-implementer",
    template: "ghafk-issue.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  linearImplementer: {
    name: "linear-implementer",
    template: "linearafk.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  linearIssueImplementer: {
    name: "linear-issue-implementer",
    template: "linearafk-issue.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  verifier: {
    name: "verifier",
    template: "verify.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  applyReviewImplementer: {
    name: "apply-review-implementer",
    template: "apply-review.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  reviewer: {
    name: "reviewer",
    template: "review.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  // P12 public journal (issue #67): generate a generic field note from a memory
  // learning, and adversarially screen a candidate note for leaks. Both produce
  // only text — the harness owns the secrecy gate and the actual posting.
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
};
