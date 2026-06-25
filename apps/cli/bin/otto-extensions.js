#!/usr/bin/env node
import { runExtensions } from "@phamvuhoang/otto-core";

runExtensions(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
