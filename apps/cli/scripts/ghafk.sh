#!/bin/bash
set -eo pipefail

# Workspace = caller's cwd. Dockerfile resolution = bundled (packages/core).
# Arg validation handled by otto-ghafk JS (supports --help, --print-config).
if command -v otto-ghafk >/dev/null 2>&1; then
  exec otto-ghafk "$@"
fi
if [ -x "./node_modules/.bin/otto-ghafk" ]; then
  exec ./node_modules/.bin/otto-ghafk "$@"
fi
exec npx -y @phamvuhoang/otto otto-ghafk "$@"
