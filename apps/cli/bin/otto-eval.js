#!/usr/bin/env node
import { runEval } from "@phamvuhoang/otto-core";

runEval(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
