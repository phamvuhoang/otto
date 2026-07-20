#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runReview } from "@phamvuhoang/otto-core";

const here = dirname(fileURLToPath(import.meta.url));
const cliVersion = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8")
).version;

runReview(process.argv.slice(2), { cliVersion }).catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
