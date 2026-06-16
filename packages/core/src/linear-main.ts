import { parseLinearIssueArg } from "./linear-api.js";
import { runBin } from "./run-bin.js";
import { STAGES } from "./stages.js";

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
  });
}
