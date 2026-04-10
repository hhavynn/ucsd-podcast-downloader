// Milestone 6: Live download progress
// The popup now renders durable per-tab download state from chrome.storage.local.

const STALE_MS = 30 * 60 * 1000; // warn after 30 minutes
const IN_FLIGHT_STATUSES = new Set(["starting", "downloading", "merging"]);

let activeTabId = null;
let currentStreamData = null;
let currentDownloadState = null;

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
  progress:     document.getElementById("download-progress"),
  progressStatus: document.getElementById("progress-status"),
  progressFill: document.getElementById("progress-fill"),
  progressMeta: document.getElementById("progress-meta"),
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

function clampPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value) {
  const percent = clampPercent(value);
  if (percent == null) return "";
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, "");
}

function downloadKey(tabId) {
  return `download_${tabId}`;
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

function getCurrentFilename() {
  if (!currentStreamData) return "lecture.mp4";
  return currentStreamData.filename || makeFilename(currentStreamData.title || "lecture");
}

function renderStreamState(data) {
  currentStreamData = data || null;

  if (!data) {
    showState("none");
    return;
  }

  el.title.textContent = data.title || "Unknown";
  el.filename.textContent = getCurrentFilename();
  el.time.textContent = formatTime(data.detectedAt);

  const age = Date.now() - data.detectedAt;
  el.staleWarning.classList.toggle("hidden", age < STALE_MS);

  showState("found");
}

function setDlResult(kind, text = "") {
  if (!text) {
    el.dlResult.className = "dl-result hidden";
    el.dlResult.textContent = "";
    return;
  }

  el.dlResult.textContent = text;
  el.dlResult.className = `dl-result ${kind}`;
}

function buildProgressMeta(state) {
  const parts = [];

  if (state.downloadedBytesText) parts.push(state.downloadedBytesText);
  if (state.speedText) parts.push(state.speedText);
  if (state.etaText) parts.push(`ETA ${state.etaText}`);

  return parts.join(" | ");
}

function renderDownloadState(state) {
  currentDownloadState = state || null;
  console.log("[popup] render download state ->", state);

  el.download.disabled = false;
  el.download.textContent = "Download";
  el.copy.disabled = false;
  el.progress.classList.add("hidden");
  el.progressStatus.textContent = "";
  el.progressFill.style.width = "0%";
  el.progressMeta.textContent = "";
  el.progressMeta.classList.add("hidden");

  if (!state) {
    setDlResult();
    return;
  }

  const percent = clampPercent(state.progressPercent);
  const meta = buildProgressMeta(state);
  const inFlight = IN_FLIGHT_STATUSES.has(state.status);

  el.progress.classList.remove("hidden");
  el.progressFill.style.width = `${percent ?? 0}%`;
  el.download.disabled = inFlight;
  el.copy.disabled = inFlight;

  if (inFlight) {
    el.download.textContent = "Downloading...";
  }

  if (meta) {
    el.progressMeta.textContent = meta;
    el.progressMeta.classList.remove("hidden");
  }

  switch (state.status) {
    case "starting":
      el.progressStatus.textContent = state.message || "Preparing download...";
      setDlResult();
      break;

    case "downloading":
      el.progressStatus.textContent = state.message || `Downloading... ${formatPercent(percent)}%`;
      setDlResult("dl-downloading", "Download in progress.");
      break;

    case "merging":
      el.progressStatus.textContent = state.message || "Merging...";
      setDlResult("dl-downloading", "Finalizing the video file.");
      break;

    case "done": {
      el.progressStatus.textContent = "Completed";
      el.progressFill.style.width = "100%";
      const savedName = state.path ? state.path.replace(/.*[\\/]/, "") : state.filename || getCurrentFilename();
      const detail = state.message ? ` (${state.message})` : "";
      setDlResult("dl-ok", `Saved: ${savedName}${detail}`);
      break;
    }

    case "error":
      el.progressStatus.textContent = "Error";
      setDlResult("dl-err", state.message || "Download failed.");
      break;

    default:
      el.progress.classList.add("hidden");
      setDlResult();
  }
}

async function loadActiveTabState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    activeTabId = null;
    renderStreamState(null);
    renderDownloadState(null);
    return;
  }

  activeTabId = tab.id;
  const streamKey = `tab_${activeTabId}`;
  const dlKey = downloadKey(activeTabId);
  const result = await chrome.storage.local.get([streamKey, dlKey]);

  console.log("[popup] loaded state ->", {
    tabId: activeTabId,
    stream: result[streamKey],
    download: result[dlKey],
  });

  renderStreamState(result[streamKey]);
  renderDownloadState(result[dlKey]);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || activeTabId == null) return;

  const streamKey = `tab_${activeTabId}`;
  const dlKey = downloadKey(activeTabId);

  if (changes[streamKey]) {
    console.log("[popup] stream state change ->", changes[streamKey].newValue);
    renderStreamState(changes[streamKey].newValue || null);
  }

  if (changes[dlKey]) {
    console.log("[popup] download state change ->", changes[dlKey].newValue);
    renderDownloadState(changes[dlKey].newValue || null);
  }
});

// Copy URL
el.copy.addEventListener("click", async () => {
  if (activeTabId == null) return;

  const result = await chrome.storage.local.get(`tab_${activeTabId}`);
  const url = result[`tab_${activeTabId}`]?.m3u8Url;
  if (!url) return;

  await navigator.clipboard.writeText(url);
  el.copy.textContent = "Copied!";
  el.copy.classList.add("copied");
  setTimeout(() => {
    el.copy.textContent = "Copy URL";
    el.copy.classList.remove("copied");
  }, 1500);
});

// Download
el.download.addEventListener("click", async () => {
  if (activeTabId == null || !currentStreamData) return;
  if (currentDownloadState && IN_FLIGHT_STATUSES.has(currentDownloadState.status)) return;

  const url = currentStreamData.m3u8Url;
  const filename = getCurrentFilename();
  if (!url) {
    renderDownloadState({
      status: "error",
      filename,
      progressPercent: null,
      speedText: "",
      etaText: "",
      downloadedBytesText: "",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      path: "",
      message: "No stream found for this tab. Reload and play the video.",
    });
    return;
  }

  el.download.disabled = true;
  el.download.textContent = "Downloading...";

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_VIDEO",
      tabId: activeTabId,
      url,
      filename,
    });
  } catch (e) {
    renderDownloadState({
      status: "error",
      filename,
      progressPercent: null,
      speedText: "",
      etaText: "",
      downloadedBytesText: "",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      path: "",
      message: `Extension error: ${e.message}\n\nTry reloading the extension.`,
    });
    return;
  }

  if (!result?.ok) {
    renderDownloadState({
      status: "error",
      filename,
      progressPercent: null,
      speedText: "",
      etaText: "",
      downloadedBytesText: "",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      path: "",
      message: result?.message || "Failed to start download.",
    });
  }
});

// Native host ping
el.ping.addEventListener("click", async () => {
  el.ping.disabled = true;
  el.ping.textContent = "Pinging...";
  el.pingResult.className = "ping-result hidden";

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "PING_NATIVE" });
  } catch (e) {
    setPingResult(false, `Extension error: ${e.message}`);
    el.ping.disabled = false;
    el.ping.textContent = "Test Connection";
    return;
  }

  setPingResult(
    result.success,
    result.success
      ? `Native host v${result.response?.version ?? "?"} is reachable.`
      : result.error
  );

  el.ping.disabled = false;
  el.ping.textContent = "Test Connection";
});

function setPingResult(ok, text) {
  el.pingResult.textContent = text;
  el.pingResult.className = `ping-result ${ok ? "ping-ok" : "ping-err"}`;
}

loadActiveTabState();
