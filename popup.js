// Milestone 5: UX Polish
// Stale detection, improved filename generation, full button locking during download.

const STALE_MS = 30 * 60 * 1000; // warn after 30 minutes

const el = {
  loading:      document.getElementById("state-loading"),
  none:         document.getElementById("state-none"),
  found:        document.getElementById("state-found"),
  title:        document.getElementById("info-title"),
  filename:     document.getElementById("info-filename"),
  time:         document.getElementById("info-time"),
  staleWarning: document.getElementById("stale-warning"),
  copy:         document.getElementById("btn-copy"),
  download:     document.getElementById("btn-download"),
  dlResult:     document.getElementById("dl-result"),
  ping:         document.getElementById("btn-ping"),
  pingResult:   document.getElementById("ping-result"),
};

function showState(name) {
  ["loading", "none", "found"].forEach((s) => {
    el[s].classList.toggle("hidden", s !== name);
  });
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Strip common Kaltura/Canvas/UCSD suffixes from page titles and return a
// safe .mp4 filename. The native host sanitizes again as a second layer.
function makeFilename(title) {
  let name = title
    // Remove site-name suffixes appended by the browser/Kaltura/Canvas
    .replace(/\s*[|–—]\s*(UCSD\s*Podcast|Kaltura|Canvas|UC\s*San\s*Diego)\s*$/i, "")
    .replace(/\s*-\s*(Canvas|Kaltura)\s*$/i, "")
    // Strip a leading "hostname - " prefix (e.g. "podcast.ucsd.edu - Lecture 5")
    .replace(/^[\w.-]+\.(edu|com|org)\s*[-–|]\s*/i, "")
    // Remove filesystem-unsafe characters (Windows + macOS union)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return (name || "lecture") + ".mp4";
}

// ── Stream detection state ────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showState("none"); return; }

  const key = `tab_${tab.id}`;
  const result = await chrome.storage.local.get(key);
  const data = result[key];

  if (!data) { showState("none"); return; }

  // Prefer the DOM-extracted filename stored at detection time.
  // Fall back to deriving it from the tab title if extraction failed.
  const filename = data.filename || makeFilename(data.title || "lecture");

  el.title.textContent    = data.title || "Unknown";
  el.filename.textContent = filename;
  el.time.textContent     = formatTime(data.detectedAt);

  // Warn if the stored URL is old enough that the KS token may have expired.
  const age = Date.now() - data.detectedAt;
  el.staleWarning.classList.toggle("hidden", age < STALE_MS);

  showState("found");
}

// ── Copy URL ──────────────────────────────────────────────────────────────────

el.copy.addEventListener("click", () => {
  // Retrieve the URL directly from storage rather than from a hidden DOM element.
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.storage.local.get(`tab_${tab.id}`, (res) => {
      const url = res[`tab_${tab.id}`]?.m3u8Url;
      if (!url) return;
      navigator.clipboard.writeText(url).then(() => {
        el.copy.textContent = "Copied!";
        el.copy.classList.add("copied");
        setTimeout(() => {
          el.copy.textContent = "Copy URL";
          el.copy.classList.remove("copied");
        }, 1500);
      });
    });
  });
});

// ── Download ──────────────────────────────────────────────────────────────────

el.download.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const stored = await chrome.storage.local.get(`tab_${tab.id}`);
  const data = stored[`tab_${tab.id}`];
  if (!data) { setDlState("error", "No stream found for this tab. Reload and play the video."); return; }

  const url      = data.m3u8Url;
  const filename = data.filename || makeFilename(data.title || "lecture");

  setDlState("downloading");

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "DOWNLOAD_VIDEO", url, filename });
  } catch (e) {
    setDlState("error", `Extension error: ${e.message}\n\nTry reloading the extension.`);
    return;
  }

  if (result.ok) {
    // Show just the filename, not the full path — the path can be very long.
    const savedName = result.path.replace(/.*[\\/]/, "");
    setDlState("done", `Saved: ${savedName} (${result.message})`);
  } else {
    setDlState("error", result.message);
  }
});

function setDlState(state, text = "") {
  // Reset everything first.
  el.download.disabled    = false;
  el.download.textContent = "Download";
  el.copy.disabled        = false;
  el.dlResult.className   = "dl-result";

  switch (state) {
    case "downloading":
      el.download.disabled    = true;
      el.download.textContent = "Downloading…";
      el.copy.disabled        = true;
      el.dlResult.textContent = "Download in progress — keep this popup open.";
      el.dlResult.classList.add("dl-downloading");
      break;
    case "done":
      el.dlResult.textContent = text;
      el.dlResult.classList.add("dl-ok");
      break;
    case "error":
      el.dlResult.textContent = text;
      el.dlResult.classList.add("dl-err");
      break;
  }
}

// ── Native host ping ──────────────────────────────────────────────────────────

el.ping.addEventListener("click", async () => {
  el.ping.disabled    = true;
  el.ping.textContent = "Pinging…";
  el.pingResult.className = "ping-result hidden";

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "PING_NATIVE" });
  } catch (e) {
    setPingResult(false, `Extension error: ${e.message}`);
    el.ping.disabled    = false;
    el.ping.textContent = "Test Connection";
    return;
  }

  setPingResult(
    result.success,
    result.success
      ? `Native host v${result.response?.version ?? "?"} is reachable.`
      : result.error
  );

  el.ping.disabled    = false;
  el.ping.textContent = "Test Connection";
});

function setPingResult(ok, text) {
  el.pingResult.textContent = text;
  el.pingResult.className   = `ping-result ${ok ? "ping-ok" : "ping-err"}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
