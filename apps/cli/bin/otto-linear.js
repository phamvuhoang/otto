#!/usr/bin/env node
import { runLinear } from "@phamvuhoang/otto-core";

runLinear(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
