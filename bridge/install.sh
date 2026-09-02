#!/usr/bin/env bash
# Installs the SubVibe → Claude Code bridge (a native messaging host) for
# Chrome, Brave, Chromium and Edge on macOS, and for Chrome/Brave/Chromium on
# Linux. Run once; rerun after moving the folder or changing the extension id.
#
#   bash bridge/install.sh <extension-id>
#
# The id is shown in the SubVibe popup (Keys → Claude Code on this Mac) and at
# chrome://extensions. Needs the `claude` CLI (Claude Code) and `node` on PATH.
set -euo pipefail

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "usage: bash bridge/install.sh <extension-id>   (the id from chrome://extensions or the SubVibe popup)" >&2
  exit 2
fi
HOST_NAME="com.subvibe.claude"
HOST_DIR="$HOME/.subvibe"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "error: the 'claude' CLI is not on PATH. Install Claude Code and log in (claude → /login) first." >&2
  exit 1
fi
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node is not on PATH (Claude Code needs it too)." >&2
  exit 1
fi

mkdir -p "$HOST_DIR"
sed -e "s|__CLAUDE_BIN__|$CLAUDE_BIN|" \
    -e "1s|.*|#!$NODE_BIN|" \
    "$SRC_DIR/subvibe-claude-host.mjs" > "$HOST_DIR/subvibe-claude-host.mjs"
chmod +x "$HOST_DIR/subvibe-claude-host.mjs"

manifest() {
  cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "SubVibe bridge to the local Claude Code CLI (translate with your own subscription)",
  "path": "$HOST_DIR/subvibe-claude-host.mjs",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
}

case "$(uname -s)" in
  Darwin)
    DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    ) ;;
  Linux)
    DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
    ) ;;
  *) echo "error: unsupported OS $(uname -s) — on Windows the host manifest is registered in the registry; not automated yet." >&2; exit 1 ;;
esac

for DIR in "${DIRS[@]}"; do
  mkdir -p "$DIR"
  manifest > "$DIR/$HOST_NAME.json"
  echo "installed: $DIR/$HOST_NAME.json"
done

echo "host: $HOST_DIR/subvibe-claude-host.mjs (claude: $CLAUDE_BIN, node: $NODE_BIN)"
echo "Now: reload SubVibe, open the popup → Keys → Claude Code on this Mac → Test."
