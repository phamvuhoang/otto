#!/usr/bin/env node
import { runRuns } from "@phamvuhoang/otto-core";

runRuns(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
