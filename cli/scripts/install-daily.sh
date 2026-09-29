#!/usr/bin/env bash
# Train every day at 07:30 (launchd). Remove with: cli/scripts/install-daily.sh --remove
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
label="dev.ghostmind.agento-train"
plist="$HOME/Library/LaunchAgents/$label.plist"
if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "removed $label"
  exit 0
fi
# launchd starts with an empty environment. The job runs through your login shell, which already
# exports VAULT_ADDR / VAULT_TOKEN and puts node and varlock on the PATH, so no secret is written here.
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lic</string><string>NO_COLOR=1 exec /bin/bash '$here/scripts/train.sh'</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$HOME/.agento/gym/launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/.agento/gym/launchd.log</string>
</dict>
</plist>
PLIST
chmod 600 "$plist"
mkdir -p "$HOME/.agento/gym"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed $label: every day at 07:30 → ~/.agento/gym/daily.log (remove: $0 --remove)"
