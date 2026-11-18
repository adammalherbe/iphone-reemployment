#!/bin/zsh
# Stop iPhone Reemployment from starting automatically.
PLIST="$HOME/Library/LaunchAgents/com.iphone-reemployment.server.plist"
launchctl unload "$PLIST" 2>/dev/null
rm -f "$PLIST"
echo "Autostart is off."
