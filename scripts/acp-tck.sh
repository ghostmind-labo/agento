#!/usr/bin/env bash
# Runs the Agent Client Protocol's own compliance kit (acp-tck) against agento's ACP server, on a
# stand-in model: no key, no spend. Needs `uv` and network (it fetches the kit on the first run).
#   npm run tck            extra kit options pass through:  npm run tck -- --report-json /tmp/tck.json
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cache="${ACP_TCK_DIR:-$HOME/.cache/acp-tck}"
if [[ -d "$cache/.git" ]]; then git -C "$cache" pull -q --ff-only || true; else git clone -q --depth 1 https://github.com/agentclientprotocol/acp-tck "$cache"; fi
cd "$cache"
exec uv run acp-tck --timeout 20 "$@" -- node "$root/test/fixtures/acp-stub-agent.mts"
