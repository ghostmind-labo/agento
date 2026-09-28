#!/usr/bin/env bash
# The CLI's offline tests (they live with the package's suites): no key, no network, $0.
set -euo pipefail
cd "$(dirname "$0")/../.."
node test/run.mts cli
