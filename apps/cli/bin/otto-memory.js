#!/usr/bin/env node
import { runMemory } from "@phamvuhoang/otto-core";

runMemory(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
