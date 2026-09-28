#!/usr/bin/env bash
# The REPL, working in the repo root. Config comes from varlock (the routine wraps this script).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here/.."
exec node "$here/../src/cli/main.ts" "$@"
