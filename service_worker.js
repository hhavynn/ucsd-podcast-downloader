// Stream Detection + DOM Filename Extraction
// Observes network requests, captures .m3u8 playlist URLs per tab, and refreshes
// lecture state whenever the tab's main document changes.

// Injected into the podcast page via chrome.scripting.executeScript.
// Must be self-contained; it runs in the page context, not the service worker.
function extractPageMeta() {
  function xpathText(expr) {
    const r = document.evaluate(
      expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    );
    return r.singleNodeValue?.textContent?.trim() ?? "";
  }

  function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  const courseRaw = normalizeWhitespace(xpathText(
    "/html/body/div[5]/div[1]/div/div[1]/div/h1/span"
  ));
  const lectureRaw = normalizeWhitespace(xpathText(
    "/html/body/div[5]/div[1]/div/div[1]/div/form/div[3]/div[1]/h2"
  ));

  const courseMatch = courseRaw.match(/\b([A-Z]{2,5}\s+\d+[A-Z]*)\b/);
  const lectureMatch = lectureRaw.match(/\b(Lecture\s+\d+)\b/i);
  const lectureLabel = lectureMatch
    ? `Lecture ${lectureMatch[1].match(/\d+/)?.[0]}`
    : null;

  return {
    courseCode: courseMatch ? courseMatch[1] : null,
    lectureLabel,
    lectureRaw,
  };
}

const META_RETRY_DELAYS_MS = [0, 300, 1000, 2500];
const lectureContexts = new Map();
// Tracks tabs where a detection is already in-flight to prevent a race between
// two .m3u8 requests (master + sub-playlist) both passing the "already stored?"
// check before either finishes, causing the wrong URL to be written last.
const detectionInProgress = new Set();

function ensureLectureContext(tabId) {
  let context = lectureContexts.get(tabId);
  if (!context) {
    context = {
      navigationVersion: 0,
      currentDocumentId: null,
      currentUrl: null,
    };
    lectureContexts.set(tabId, context);
  }
  return context;
}

function isMainFrameNavigation(details) {
  return details.frameId === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshCurrentLectureState(tabId, { reason, url, documentId } = {}) {
  if (tabId < 0) return;

  const context = ensureLectureContext(tabId);
  context.navigationVersion += 1;
  if (documentId !== undefined) context.currentDocumentId = documentId ?? null;
  if (url !== undefined) context.currentUrl = url ?? null;

  // Cancel any in-flight detection so it doesn't write to storage after clearing.
  detectionInProgress.delete(tabId);

  await chrome.storage.local.remove(`tab_${tabId}`);
  console.log(
    `[UCSD Downloader] tab ${tabId}: cleared lecture state (${reason}) ` +
    `nav=${context.navigationVersion} doc=${context.currentDocumentId ?? "?"}`
  );
}

async function extractPageMetaWithRetry(tabId, navigationVersion) {
  let lastMeta = null;
  let lastError = null;

  for (const delayMs of META_RETRY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs);

    const currentContext = lectureContexts.get(tabId);
    if (currentContext && currentContext.navigationVersion !== navigationVersion) {
      console.log(`[UCSD Downloader] tab ${tabId}: aborting DOM extraction for old navigation.`);
      return null;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageMeta,
      });
      const meta = results?.[0]?.result ?? null;
      if (meta) lastMeta = meta;

      if (meta?.courseCode && meta?.lectureLabel) {
        console.log(`[UCSD Downloader] tab ${tabId}: page meta resolved after ${delayMs}ms ->`, meta);
        return meta;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    console.warn(`[UCSD Downloader] tab ${tabId}: DOM extraction retries failed - ${lastError.message}`);
  }
  return lastMeta;
}

async function handleDetectedPlaylist(details) {
  if (!details.url.includes(".m3u8")) return;
  if (details.tabId < 0) return;

  const tabId = details.tabId;

  // Synchronous fast-path: if another .m3u8 for this tab is already being
  // processed, drop this one immediately — before any async work — so the
  // first-arriving URL (typically the master playlist) wins.
  if (detectionInProgress.has(tabId)) return;

  const key = `tab_${tabId}`;
  const context = ensureLectureContext(tabId);

  if (details.documentId && context.currentDocumentId && details.documentId !== context.currentDocumentId) {
    console.log(
      `[UCSD Downloader] tab ${tabId}: ignoring .m3u8 from old document ` +
      `${details.documentId} (current ${context.currentDocumentId})`
    );
    return;
  }

  const existing = await chrome.storage.local.get(key);
  if (existing[key]?.navigationVersion === context.navigationVersion) {
    console.log(`[UCSD Downloader] tab ${tabId}: .m3u8 already stored for current navigation, skipping.`);
    return;
  }

  // Claim this detection slot after the storage read — a concurrent call could
  // have claimed it while we were awaiting, so check again before proceeding.
  if (detectionInProgress.has(tabId)) return;
  detectionInProgress.add(tabId);

  // Hold the lock through the storage write so no concurrent call can race the
  // write window between extractPageMetaWithRetry completing and set() finishing.
  const navigationVersion = context.navigationVersion;
  try {
    const meta = await extractPageMetaWithRetry(tabId, navigationVersion);

    if (ensureLectureContext(tabId).navigationVersion !== navigationVersion) {
      console.log(`[UCSD Downloader] tab ${tabId}: navigation changed during detection, discarding result.`);
      return;
    }

    let filename = null;
    if (meta?.courseCode && meta?.lectureLabel) {
      const safe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
      filename = `${safe(meta.courseCode)} - ${safe(meta.lectureLabel)}`;
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (err) {
      console.warn(`[UCSD Downloader] tab ${tabId}: failed to read tab info - ${err.message}`);
    }

    const stored = {
      m3u8Url: details.url,
      detectedAt: Date.now(),
      title: tab?.title || "Unknown",
      filename,
      documentId: details.documentId ?? context.currentDocumentId ?? null,
      pageUrl: context.currentUrl ?? tab?.url ?? null,
      navigationVersion,
    };

    await chrome.storage.local.set({ [key]: stored });
    console.log(`[UCSD Downloader] tab ${tabId}: stored lecture state ->`, stored);
  } finally {
    detectionInProgress.delete(tabId);
  }
}

// Broad URL filter; webRequest requires patterns at registration time.
const M3U8_FILTER = {
  urls: ["*://*/*m3u8*"],
  types: ["media", "xmlhttprequest", "other"]
};

chrome.webRequest.onBeforeRequest.addListener((details) => {
  void handleDetectedPlaylist(details).catch((err) => {
    console.error(`[UCSD Downloader] tab ${details.tabId}: playlist detection failed:`, err);
  });
}, M3U8_FILTER);

chrome.webNavigation.onCommitted.addListener((details) => {
  if (!isMainFrameNavigation(details)) return;
  void refreshCurrentLectureState(details.tabId, {
    reason: "main-frame navigation",
    url: details.url,
    documentId: details.documentId,
  });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (!isMainFrameNavigation(details)) return;
  void refreshCurrentLectureState(details.tabId, {
    reason: "history state updated",
    url: details.url,
    documentId: details.documentId,
  });
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (!isMainFrameNavigation(details)) return;
  void refreshCurrentLectureState(details.tabId, {
    reason: "fragment navigation",
    url: details.url,
    documentId: details.documentId,
  });
});

const NATIVE_HOST = "com.ucsd.podcast.downloader";
const activeDownloads = new Map();

function downloadKey(tabId) {
  return `download_${tabId}`;
}

function buildDownloadState(existing = {}, patch = {}) {
  const now = patch.updatedAt ?? Date.now();
  return {
    status: patch.status ?? existing.status ?? "starting",
    filename: patch.filename ?? existing.filename ?? "",
    progressPercent: patch.progressPercent ?? existing.progressPercent ?? null,
    speedText: patch.speedText ?? existing.speedText ?? "",
    etaText: patch.etaText ?? existing.etaText ?? "",
    downloadedBytesText: patch.downloadedBytesText ?? existing.downloadedBytesText ?? "",
    startedAt: patch.startedAt ?? existing.startedAt ?? now,
    updatedAt: now,
    path: patch.path ?? existing.path ?? "",
    message: patch.message ?? existing.message ?? "",
  };
}

async function persistDownloadState(tabId, patch, record = activeDownloads.get(tabId)) {
  const next = buildDownloadState(record?.lastState, patch);
  if (record) record.lastState = next;

  await chrome.storage.local.set({ [downloadKey(tabId)]: next });
  console.log(`[UCSD Downloader] tab ${tabId}: download state ->`, next);
  return next;
}

async function writeTerminalState(tabId, record, patch) {
  record.terminalWritten = true;
  await persistDownloadState(tabId, patch, record);
  activeDownloads.delete(tabId);

  try {
    record.port?.disconnect();
  } catch (err) {
    console.warn(`[UCSD Downloader] tab ${tabId}: port disconnect failed - ${err.message}`);
  }
}

function formatDownloadMessage(percent) {
  if (typeof percent !== "number") return "Downloading...";
  const rounded = Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, "");
  return `Downloading... ${rounded}%`;
}

function attachDownloadPort(tabId, record) {
  record.port.onMessage.addListener((payload) => {
    void handleNativeDownloadMessage(tabId, record, payload);
  });

  record.port.onDisconnect.addListener(() => {
    void handleDownloadDisconnect(tabId, record);
  });
}

async function handleNativeDownloadMessage(tabId, record, payload) {
  console.log(`[UCSD Downloader] tab ${tabId}: native event "${payload?.type}" ->`, payload);

  switch (payload?.type) {
    case "download_started":
      await persistDownloadState(tabId, {
        status: "starting",
        filename: payload.filename ?? record.filename,
        startedAt: record.startedAt,
        message: payload.message || "Preparing download...",
      }, record);
      return;

    case "download_progress": {
      const percent = typeof payload.percent === "number"
        ? payload.percent
        : record.lastState?.progressPercent ?? null;

      await persistDownloadState(tabId, {
        status: "downloading",
        progressPercent: percent,
        speedText: payload.speedText ?? record.lastState?.speedText ?? "",
        etaText: payload.etaText ?? record.lastState?.etaText ?? "",
        downloadedBytesText: payload.downloadedBytesText ?? record.lastState?.downloadedBytesText ?? "",
        message: payload.message || formatDownloadMessage(percent),
      }, record);
      return;
    }

    case "download_merging":
      await persistDownloadState(tabId, {
        status: "merging",
        message: payload.message || "Merging...",
      }, record);
      return;

    case "download_done":
      await writeTerminalState(tabId, record, {
        status: "done",
        progressPercent: 100,
        etaText: "",
        path: payload.path || "",
        message: payload.message || "Completed",
      });
      return;

    case "download_error":
      await writeTerminalState(tabId, record, {
        status: "error",
        message: payload.message || "Download failed.",
      });
      return;

    default:
      console.warn(`[UCSD Downloader] tab ${tabId}: ignoring unknown native event "${payload?.type}"`);
  }
}

async function handleDownloadDisconnect(tabId, record) {
  const errorMessage = chrome.runtime.lastError?.message || "Native host disconnected unexpectedly.";
  console.warn(`[UCSD Downloader] tab ${tabId}: native port disconnected (${errorMessage})`);

  if (record.terminalWritten) return;

  record.terminalWritten = true;
  await persistDownloadState(tabId, {
    status: "error",
    message: errorMessage,
  }, record);
  activeDownloads.delete(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  lectureContexts.delete(tabId);
  detectionInProgress.delete(tabId);
  chrome.storage.local.remove([`tab_${tabId}`, `download_${tabId}`]);

  // Disconnect any active native port for this tab and mark it terminal so the
  // onDisconnect handler doesn't try to write state for a removed tab.
  const record = activeDownloads.get(tabId);
  if (record && !record.terminalWritten) {
    record.terminalWritten = true;
    try { record.port?.disconnect(); } catch (_) {}
    activeDownloads.delete(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "PING_NATIVE") {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST,
      { type: "ping" },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, response });
        }
      }
    );
    return true;
  }

  if (message.type === "DOWNLOAD_VIDEO") {
    void (async () => {
      const tabId = Number(message.tabId);
      const url = typeof message.url === "string" ? message.url : "";
      const filename = typeof message.filename === "string" ? message.filename : "";

      if (!Number.isInteger(tabId) || tabId < 0) {
        sendResponse({ ok: false, message: "Missing tabId for download." });
        return;
      }
      if (!url) {
        sendResponse({ ok: false, message: "No URL provided for download." });
        return;
      }
      if (!filename) {
        sendResponse({ ok: false, message: "No filename provided for download." });
        return;
      }
      if (activeDownloads.has(tabId)) {
        console.warn(`[UCSD Downloader] tab ${tabId}: duplicate download start blocked.`);
        sendResponse({ ok: false, message: "Download already in progress for this tab." });
        return;
      }

      const startedAt = Date.now();
      const record = {
        port: null,
        filename,
        startedAt,
        terminalWritten: false,
        lastState: buildDownloadState({}, {
          status: "starting",
          filename,
          progressPercent: null,
          speedText: "",
          etaText: "",
          downloadedBytesText: "",
          startedAt,
          path: "",
          message: "Preparing download...",
        }),
      };

      await persistDownloadState(tabId, record.lastState, record);

      try {
        record.port = chrome.runtime.connectNative(NATIVE_HOST);
      } catch (err) {
        record.terminalWritten = true;
        await persistDownloadState(tabId, {
          status: "error",
          message: err.message || "Failed to connect to native host.",
        }, record);
        sendResponse({ ok: false, message: err.message || "Failed to connect to native host." });
        return;
      }

      activeDownloads.set(tabId, record);
      attachDownloadPort(tabId, record);

      console.log(`[UCSD Downloader] tab ${tabId}: opened native port for "${filename}"`);
      record.port.postMessage({ type: "download_video", tabId, url, filename });
      sendResponse({ ok: true, started: true });
    })().catch(async (err) => {
      const tabId = Number(message.tabId);
      console.error("[UCSD Downloader] download setup failed:", err);

      if (Number.isInteger(tabId) && tabId >= 0) {
        const record = activeDownloads.get(tabId);
        if (record && !record.terminalWritten) {
          record.terminalWritten = true;
          await persistDownloadState(tabId, {
            status: "error",
            message: err.message || "Download setup failed.",
          }, record);
          activeDownloads.delete(tabId);
        }
      }

      sendResponse({ ok: false, message: err.message || "Download setup failed." });
    });
    return true;
  }
});
