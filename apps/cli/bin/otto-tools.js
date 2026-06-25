#!/usr/bin/env node
import { runTools } from "@phamvuhoang/otto-core";

runTools(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
