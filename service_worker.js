// Stream Detection + DOM Filename Extraction
// Observes all network requests and captures .m3u8 playlist URLs per tab.
// At detection time, injects extractPageMeta() into the tab to read the
// course code and lecture number directly from the page DOM.
// State is stored in chrome.storage.local so the popup can read it.

// Injected into the podcast page via chrome.scripting.executeScript.
// Must be self-contained — it runs in the page context, not the service worker.
function extractPageMeta() {
  function xpathText(expr) {
    const r = document.evaluate(
      expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    );
    return r.singleNodeValue?.textContent?.trim() ?? "";
  }

  const courseCode = xpathText(
    "/html/body/div[5]/div[1]/div/div[1]/div/h1/span"
  );
  const lectureRaw = xpathText(
    "/html/body/div[5]/div[1]/div/div[1]/div/form/div[3]/div[1]/h2"
  );
  // "Lecture 2, 4/2/2026"  →  capture "2"
  const match = lectureRaw.match(/Lecture\s+(\d+)/i);

  return {
    courseCode:    courseCode || null,
    lectureNumber: match ? match[1] : null,
    lectureRaw,                             // kept for debugging
  };
}

// Broad URL filter — webRequest requires patterns at registration time.
// The handler re-checks for ".m3u8" to avoid false positives from the wildcard.
const M3U8_FILTER = {
  urls: ["*://*/*m3u8*"],
  // "media" catches video segment requests; xmlhttprequest catches JS-initiated
  // playlist fetches; "other" is a catch-all for unusual loaders.
  types: ["media", "xmlhttprequest", "other"]
};

chrome.webRequest.onBeforeRequest.addListener((details) => {
  // Guard: only store if the URL actually contains the .m3u8 extension.
  // This prevents hits like "?token=notam3u8thing" from slipping through.
  if (!details.url.includes(".m3u8")) return;

  // tabId is -1 for requests not associated with a tab (e.g. prefetch).
  // Ignore those — we need a real tab to display the result in the popup.
  if (details.tabId < 0) return;

  const key = `tab_${details.tabId}`;

  // Only store the first (master) playlist per tab.
  // Master playlists are fetched once; segment playlists are fetched repeatedly.
  // We prefer the earliest URL because it's most likely the top-level manifest.
  // async IIFE so we can await executeScript without blocking the listener.
  chrome.storage.local.get(key, async (existing) => {
    if (existing[key]) {
      console.log(`[UCSD Downloader] tab ${details.tabId}: .m3u8 seen but already stored, skipping.`);
      return;
    }

    // 1. Try to extract course code + lecture number from the page DOM.
    let filename = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        func: extractPageMeta,
      });
      const meta = results?.[0]?.result;
      console.log(`[UCSD Downloader] tab ${details.tabId}: page meta →`, meta);

      if (meta?.courseCode && meta?.lectureNumber) {
        // Sanitize each part before joining — host.py will sanitize again.
        const safe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
        filename = `${safe(meta.courseCode)} - Lecture ${meta.lectureNumber}`;
      }
    } catch (err) {
      // executeScript can fail on restricted pages or if the DOM isn't ready.
      // Logged here; popup falls back to makeFilename(title).
      console.warn(`[UCSD Downloader] tab ${details.tabId}: DOM extraction failed — ${err.message}`);
    }

    // 2. Get the tab title as a display fallback (used if filename is null).
    chrome.tabs.get(details.tabId, (tab) => {
      chrome.storage.local.set({
        [key]: {
          m3u8Url:   details.url,
          detectedAt: Date.now(),
          title:     tab?.title || "Unknown",
          filename,  // null when DOM extraction failed; popup falls back to title
        }
      });
      console.log(`[UCSD Downloader] tab ${details.tabId}: stored → filename="${filename}"`);
    });
  });
}, M3U8_FILTER);

// Clean up storage when a tab closes to avoid unbounded growth.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`tab_${tabId}`);
});

// ── Milestone 3: Native messaging bridge ─────────────────────────────────────
// The popup cannot call sendNativeMessage directly with confidence in MV3
// (the popup context can be suspended). Route all native messaging through
// the service worker so the connection outlives popup open/close.
//
// return true is required to keep sendResponse valid after the async
// sendNativeMessage callback fires.

const NATIVE_HOST = "com.ucsd.podcast.downloader";

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
    return true; // keep the message channel open for the async callback
  }

  if (message.type === "DOWNLOAD_VIDEO") {
    console.log(`[UCSD Downloader] Download requested: ${message.filename}`);
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST,
      { type: "download_video", url: message.url, filename: message.filename },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, message: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }
});
