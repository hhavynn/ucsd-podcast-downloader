#!/usr/bin/env bash
# Registers the native messaging host with Chrome on macOS.
# Usage: bash install.sh <EXTENSION_ID>
#
# Your extension ID is the 32-character string shown under the extension
# name at chrome://extensions (e.g. abcdefghijklmnopqrstuvwxyzabcdef).

set -euo pipefail

EXTENSION_ID="${1:-}"
if [[ -z "$EXTENSION_ID" ]]; then
  echo "Usage: bash install.sh <EXTENSION_ID>"
  echo ""
  echo "Find your extension ID at chrome://extensions"
  exit 1
fi

# Absolute path to this script's directory (where host.py lives).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host.py"

if [[ ! -f "$HOST_SCRIPT" ]]; then
  echo "Error: host.py not found at $HOST_SCRIPT"
  exit 1
fi

# Make host.py executable so Chrome can launch it directly.
chmod +x "$HOST_SCRIPT"

# Chrome looks for host manifests in this directory on macOS.
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"

MANIFEST_PATH="$MANIFEST_DIR/com.ucsd.podcast.downloader.json"

cat > "$MANIFEST_PATH" <<EOF
{
  "name": "com.ucsd.podcast.downloader",
  "description": "UCSD Podcast Downloader native helper",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Installed host manifest:"
echo "  $MANIFEST_PATH"
echo ""
echo "Host script path:"
echo "  $HOST_SCRIPT"
echo ""
echo "Allowed extension:"
echo "  chrome-extension://$EXTENSION_ID/"
echo ""
echo "Now reload the extension at chrome://extensions and click 'Test Connection'."
