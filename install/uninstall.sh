#!/bin/sh
# AI_SCOPE uninstaller for macOS and Linux (run with: ai-scope --uninstall).
# Removes ~/.local/share/ai-scope, the ai-scope command and the login item.
# Asks before deleting your settings and history in ~/.ai_scope.
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ai-scope"
BIN="$HOME/.local/bin/ai-scope"
DATA="${AI_SCOPE_DATA:-$HOME/.ai_scope}"

printf '\n\033[36mUninstalling AI_SCOPE\033[0m\n'
command -v pkill >/dev/null 2>&1 && pkill -f "$ROOT/app/bin/ai-scope.js" 2>/dev/null && sleep 1

PLIST="$HOME/Library/LaunchAgents/com.ai-scope.plist"
if [ -f "$PLIST" ]; then launchctl unload "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "  Removed the login item"; fi
DESK="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/ai-scope.desktop"
if [ -f "$DESK" ]; then rm -f "$DESK"; echo "  Removed the login item"; fi

[ -f "$BIN" ] && rm -f "$BIN" && echo "  Removed $BIN"
[ -d "$ROOT" ] && rm -rf "$ROOT" && echo "  Removed $ROOT"

if [ -d "$DATA" ]; then
  printf '  Also delete your settings and history in %s ? [y/N] ' "$DATA"
  { read -r a </dev/tty; } 2>/dev/null || a=""
  case "$a" in y|Y|yes|YES) rm -rf "$DATA"; echo "  Deleted." ;; *) echo "  Kept (reinstalling picks them up again)." ;; esac
fi
printf '\n\033[32mAI_SCOPE has been uninstalled.\033[0m\n\n'
