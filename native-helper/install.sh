#!/usr/bin/env bash
# Registers the native messaging host with Chrome and/or Edge on macOS.
#
# Usage:
#   bash install.sh <CHROME_ID>                        # Chrome only (default)
#   bash install.sh --edge <EDGE_ID>                   # Edge only
#   bash install.sh <CHROME_ID> --edge <EDGE_ID>       # Both browsers
#
# Extension IDs are the 32-character strings shown in each browser's
# extensions page (chrome://extensions or edge://extensions).

set -euo pipefail

CHROME_ID=""
EDGE_ID=""

# Parse arguments.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --edge)
      shift
      EDGE_ID="${1:-}"
      if [[ -z "$EDGE_ID" ]]; then
        echo "Error: --edge requires an extension ID argument"
        exit 1
      fi
      shift
      ;;
    --*)
      echo "Unknown option: $1"
      exit 1
      ;;
    *)
      if [[ -z "$CHROME_ID" ]]; then
        CHROME_ID="$1"
      else
        echo "Unexpected argument: $1"
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$CHROME_ID" && -z "$EDGE_ID" ]]; then
  echo "Usage:"
  echo "  bash install.sh <CHROME_ID>                  # Chrome only"
  echo "  bash install.sh --edge <EDGE_ID>             # Edge only"
  echo "  bash install.sh <CHROME_ID> --edge <EDGE_ID> # Both browsers"
  echo ""
  echo "Find your extension ID at chrome://extensions or edge://extensions"
  exit 1
fi

# Absolute path to this script's directory (where host.py lives).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host.py"

if [[ ! -f "$HOST_SCRIPT" ]]; then
  echo "Error: host.py not found at $HOST_SCRIPT"
  exit 1
fi

# Make host.py executable so browsers can launch it directly.
chmod +x "$HOST_SCRIPT"

# Writes a host manifest for one browser into the given directory.
install_for_browser() {
  local browser_name="$1"
  local manifest_dir="$2"
  local extension_id="$3"

  mkdir -p "$manifest_dir"
  local manifest_path="$manifest_dir/com.ucsd.podcast.downloader.json"

  cat > "$manifest_path" <<EOF
{
  "name": "com.ucsd.podcast.downloader",
  "description": "UCSD Podcast Downloader native helper",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$extension_id/"
  ]
}
EOF

  echo "[$browser_name] Installed host manifest:"
  echo "  $manifest_path"
  echo "  Allowed extension: chrome-extension://$extension_id/"
  echo ""
}

if [[ -n "$CHROME_ID" ]]; then
  install_for_browser "Chrome" \
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
    "$CHROME_ID"
fi

if [[ -n "$EDGE_ID" ]]; then
  install_for_browser "Edge" \
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
    "$EDGE_ID"
fi

echo "Host script: $HOST_SCRIPT"
echo ""
if [[ -n "$CHROME_ID" ]]; then
  echo "Reload the extension at chrome://extensions, then click 'Test Connection'."
fi
if [[ -n "$EDGE_ID" ]]; then
  echo "Reload the extension at edge://extensions, then click 'Test Connection'."
fi
