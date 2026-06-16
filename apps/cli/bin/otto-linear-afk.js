#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runLinearAfk } from "@phamvuhoang/otto-core";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
const cliVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;

runLinearAfk(process.argv.slice(2), { cliVersion }).catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
