#!/usr/bin/env node
import { runTail } from "@phamvuhoang/otto-core";

runTail(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
