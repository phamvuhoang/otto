#!/usr/bin/env node
import { runSkills } from "@phamvuhoang/otto-core";

runSkills(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
