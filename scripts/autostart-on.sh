#!/bin/zsh
# Start iPhone Reemployment automatically when you log in to your Mac.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.iphone-reemployment.server.plist"
if [ -z "$NODE" ]; then echo "Node isn't installed. Get it from https://nodejs.org"; exit 1; fi
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.iphone-reemployment.server</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/iphone-reemployment.log</string>
  <key>StandardErrorPath</key><string>/tmp/iphone-reemployment.log</string>
</dict>
</plist>
PLIST
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "iPhone Reemployment will now start automatically when you log in. Log: /tmp/iphone-reemployment.log"
