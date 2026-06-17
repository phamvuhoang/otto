import { parseLinearIssueArg } from "./linear-api.js";
import { runBin } from "./run-bin.js";
import { STAGES } from "./stages.js";
import { pollLinearIssues } from "./watch.js";

export type RunLinearAfkOptions = { cliVersion?: string };

export async function runLinearAfk(
  argv: string[],
  opts: RunLinearAfkOptions = {}
): Promise<void> {
  await runBin(argv, {
    bin: "otto-linear-afk",
    usage: "<iterations>",
    desc: "Linear-issue-driven Claude Code AFK loop",
    stages: [STAGES.linearImplementer, STAGES.reviewer],
    takesInputArg: false,
    cliVersion: opts.cliVersion,
    issueStage: STAGES.linearIssueImplementer,
    parseIssue: parseLinearIssueArg,
    mode: "linear",
    supportsWatch: true,
    // Poll the same labelled set the implementer selects (OTTO_LINEAR_LABEL),
    // narrowed by OTTO_LINEAR_TEAM and (single-target watch scope)
    // OTTO_LINEAR_PROJECT. The `label` arg is the resolved watch label.
    watchPoll: (label) =>
      pollLinearIssues({
        label,
        team: process.env.OTTO_LINEAR_TEAM?.trim() || undefined,
        project: process.env.OTTO_LINEAR_PROJECT?.trim() || undefined,
      }),
    watchProvider: { name: "Linear", authCmd: "otto-linear-auth login" },
    resolveWatchLabel: () => process.env.OTTO_LINEAR_LABEL?.trim() || "otto",
  });
}
