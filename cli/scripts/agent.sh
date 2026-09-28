#!/usr/bin/env bash
# The REPL in whatever directory you call it from:  alias agent=/Volumes/Projects/labo/agent/cli/scripts/agent.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
exec varlock run --path "$here" -- node "$here/../src/cli/main.ts" "$@"
