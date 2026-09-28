#!/usr/bin/env bash
# Offline tests: no key, no network, $0.
set -euo pipefail
cd "$(dirname "$0")/../app"
for t in test/*.test.mts; do node "$t"; done
