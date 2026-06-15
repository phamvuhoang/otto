#!/bin/bash
set -eo pipefail

# Workspace = caller's cwd. Dockerfile resolution = bundled (packages/core).
# Arg validation handled by otto-afk JS (supports --help, --print-config).
if command -v otto-afk >/dev/null 2>&1; then
  exec otto-afk "$@"
fi
if [ -x "./node_modules/.bin/otto-afk" ]; then
  exec ./node_modules/.bin/otto-afk "$@"
fi
exec npx -y @phamvuhoang/otto otto-afk "$@"
