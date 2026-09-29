#!/usr/bin/env bash
# One training session (the gym), with the key from Vault through varlock. Logged to ~/.agento/gym/daily.log.
#   cli/scripts/train.sh                     3 rounds × 6 challenges, $0.05 cap, the saved model or the cheapest
#   cli/scripts/train.sh --rounds 5 --max-usd 0.1 --model <id>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
log="${AGENTO_HOME:-$HOME/.agento}/gym/daily.log"
mkdir -p "$(dirname "$log")"
{
  echo "── $(date '+%Y-%m-%d %H:%M')"
  varlock run --path "$here" -- node "$here/../src/cli/main.ts" train "$@"
} 2>&1 | tee -a "$log"
