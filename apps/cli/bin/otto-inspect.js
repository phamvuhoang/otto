#!/usr/bin/env node
import { runInspect } from "@phamvuhoang/otto-core";

runInspect(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
