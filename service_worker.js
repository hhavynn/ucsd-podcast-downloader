// Milestone 2: Stream Detection + Tab Title
// Observes all network requests and captures .m3u8 playlist URLs per tab.
// Also captures the page title at detection time for display in the popup.
// State is stored in chrome.storage.local so the popup can read it.

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
  chrome.storage.local.get(key, (existing) => {
    if (existing[key]) return; // already have one for this tab

    // Fetch the tab title at detection time so the popup can display it.
    chrome.tabs.get(details.tabId, (tab) => {
      chrome.storage.local.set({
        [key]: {
          m3u8Url: details.url,
          detectedAt: Date.now(),
          title: tab?.title || "Unknown"
        }
      });

      console.log(`[UCSD Downloader] Detected .m3u8 on tab ${details.tabId}:`, details.url);
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
});
