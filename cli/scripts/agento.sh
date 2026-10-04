#!/usr/bin/env bash
# The REPL in whatever directory you call it from:  alias agento=/Volumes/Projects/labo/agento/cli/scripts/agento.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
exec varlock run --path "$here" -- node "$here/../src/cli/main.ts" "$@"
