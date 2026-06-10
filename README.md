# UCSD Podcast Downloader

A Chromium extension (Manifest V3) that detects and downloads UCSD lecture streams (Kaltura/Canvas HLS). Supports Chrome and Microsoft Edge on macOS.

---

## Project structure

```
ucsd-podcast-downloader/     Chrome extension
  manifest.json
  service_worker.js
  popup.html / popup.js / popup.css
  icons/

native-helper/               Local Python helper (macOS)
  host.py                    Native messaging host
  host_manifest.json         Template (filled in by install.sh)
  install.sh                 Registers the host with Chrome
  requirements.txt
```

---

## Loading the extension

**Chrome:**
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `ucsd-podcast-downloader/` folder
4. Note the **extension ID** shown under the extension name (32-character string)

**Microsoft Edge:**
1. Open Edge → `edge://extensions`
2. Enable **Developer mode** (left sidebar toggle)
3. Click **Load unpacked** → select the `ucsd-podcast-downloader/` folder
4. Note the **extension ID** shown under the extension name

To reload after code changes: click the circular refresh icon on the extension card.

---

## Milestone 3 — Native Messaging Ping Test

### Step 1 — Get your extension ID

Go to `chrome://extensions`. Under "UCSD Podcast Downloader" you'll see something like:

```
ID: abcdefghijklmnopqrstuvwxyzabcdef
```

Copy that 32-character string.

---

### Step 2 — Register the native host (macOS)

Open Terminal, `cd` into the `native-helper/` directory, and run the command for your browser:

**Chrome only:**
```bash
bash install.sh YOUR_CHROME_EXTENSION_ID
```

**Edge only:**
```bash
bash install.sh --edge YOUR_EDGE_EXTENSION_ID
```

**Both browsers:**
```bash
bash install.sh YOUR_CHROME_EXTENSION_ID --edge YOUR_EDGE_EXTENSION_ID
```

This script makes `host.py` executable and writes a resolved manifest to the appropriate directory:
- Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Edge: `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`

Verify the installed file looks right (Chrome example):
```bash
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.ucsd.podcast.downloader.json
```

Expected output:
```json
{
  "name": "com.ucsd.podcast.downloader",
  "description": "UCSD Podcast Downloader native helper",
  "path": "/Users/you/Documents/CS/ucsd-podcast-downloader/native-helper/host.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/"
  ]
}
```

Check the `path` is absolute and the `allowed_origins` matches your extension ID exactly (including the trailing `/`).

---

### Step 3 — Verify Python works

```bash
cd native-helper/
echo '{"type":"ping"}' | python3 -c "
import sys, json, struct
msg = sys.stdin.read().strip().encode()
sys.stdout.buffer.write(struct.pack('<I', len(msg)) + msg)
sys.stdout.flush()
" | python3 host.py
```

Simpler smoke test — just run it directly and type a message manually:
```bash
python3 host.py
```
It will block waiting for input; Ctrl-C to exit. Any startup crash will print to stderr.

---

### Step 4 — Test the ping in the extension

1. Reload the extension (`chrome://extensions` or `edge://extensions` → refresh icon)
2. Open any tab and click the extension icon
3. Click **Test Connection**
4. Expected: green banner → `Pong! Native host v0.1.0 is reachable.`
5. Expected on failure: red banner with an error string (see debugging section below)

---

## Debugging native messaging failures

### Where to look

**Service worker console** — `chrome://extensions` (or `edge://extensions`) → "service worker" link:
```js
// Force a ping manually from the service worker console:
chrome.runtime.sendNativeMessage(
  "com.ucsd.podcast.downloader",
  { type: "ping" },
  (r) => console.log("response:", r, "error:", chrome.runtime.lastError)
);
```

**Popup console** — right-click the popup → Inspect → Console tab.

---

### Error messages and what they mean

| Error | Cause | Fix |
|---|---|---|
| `Specified native messaging host not found` | Host manifest not installed, or filename doesn't match the `name` field | Run `install.sh` again; confirm file is named `com.ucsd.podcast.downloader.json` |
| `Access to the specified native messaging host is forbidden` | Extension ID in `allowed_origins` doesn't match your actual extension ID | Re-run `install.sh` with the correct ID; IDs change if you remove and re-add the extension |
| `Native host has exited` | `host.py` crashed on startup | Run `python3 host.py` directly in Terminal to see the exception |
| `Could not connect to the native messaging host` | `path` in host manifest is wrong or file isn't executable | Check the path is absolute; confirm `chmod +x host.py` was run |
| `Extension error: Could not establish connection` | Service worker was idle when popup called `sendMessage` | Reload the extension; the service worker will restart |

### Quick checklist if ping fails

1. `cat ~/Library/.../com.ucsd.podcast.downloader.json` — path and extension ID look right?
2. `ls -la native-helper/host.py` — is the file executable (`-rwxr-xr-x`)?
3. `python3 --version` — is Python 3 on the PATH that Chrome sees? (Chrome uses the login shell PATH, not your interactive shell PATH)
4. Does `python3 native-helper/host.py` start without errors?
5. Did you reload the extension after running `install.sh`?

### Python PATH gotcha

Chrome launches the native host using `/usr/bin/env python3`, which resolves via the PATH from your **login** shell (not your interactive shell). If `python3` is installed via Homebrew or pyenv, it may not be on Chrome's PATH.

To confirm, run:
```bash
/usr/bin/env python3 --version
```

If that fails, edit the shebang in `host.py` to use an absolute path:
```python
#!/usr/local/bin/python3       # Homebrew Intel
#!/opt/homebrew/bin/python3    # Homebrew Apple Silicon
```

---

## Permissions explained

| Permission | Why |
|---|---|
| `webRequest` | Observe all network requests to find `.m3u8` URLs |
| `storage` | Persist detected URL + title per tab in `chrome.storage.local` |
| `tabs` | Query active tab ID in popup; get tab title in service worker |
| `nativeMessaging` | Allow the service worker to launch and talk to the local Python helper |
| `host_permissions: <all_urls>` | Required for `webRequest` to see full request details across all domains |
