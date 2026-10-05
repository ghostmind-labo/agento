#!/usr/bin/env bash
# Runs the Agent2Agent protocol's own compliance kit (a2a-tck) against agento's A2A server, on a
# scripted executor: no key, no spend. Needs `uv` and network (it fetches the kit on the first run).
#   npm run tck:a2a            extra kit options pass through:  npm run tck:a2a -- --level must
# One check is expected to fail: CORE-SEND-003, where the kit wants success and the spec an error.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cache="${A2A_TCK_DIR:-$HOME/.cache/a2a-tck}"
port="${PORT:-9999}"
if [[ -d "$cache/.git" ]]; then git -C "$cache" pull -q --ff-only || true; else git clone -q --depth 1 https://github.com/a2aproject/a2a-tck "$cache"; fi
PORT="$port" node "$root/test/fixtures/a2a-stub-agent.mts" &
agent=$!
trap 'kill "$agent" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$port/.well-known/agent-card.json" >/dev/null && break; sleep 0.1; done
cd "$cache"
uv run ./run_tck.py --sut-host "http://127.0.0.1:$port" --transport jsonrpc,http_json "$@"
