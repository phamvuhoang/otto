import { runBin } from "./run-bin.js";
import { STAGES } from "./stages.js";

export type RunAfkOptions = { cliVersion?: string };

export async function runAfk(
  argv: string[],
  opts: RunAfkOptions = {}
): Promise<void> {
  await runBin(argv, {
    bin: "otto-afk",
    usage: "<plan-and-prd> <iterations>",
    desc: "plan/PRD-driven Claude Code AFK loop",
    stages: [STAGES.implementer, STAGES.reviewer],
    takesInputArg: true,
    cliVersion: opts.cliVersion,
    verifyStage: STAGES.verifier,
    planStage: STAGES.plan,
    applyReviewStage: STAGES.applyReviewImplementer,
    mode: "afk",
  });
}
