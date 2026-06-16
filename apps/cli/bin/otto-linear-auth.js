#!/usr/bin/env node
import { runLinearAuth } from "@phamvuhoang/otto-core";

runLinearAuth(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
