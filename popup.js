// Milestone 3: Popup UI + Native Messaging ping
// Reads chrome.storage.local for the active tab and renders stream state.
// Also wires up the "Test Connection" button to ping the native host via
// the service worker (popup → service worker → native host → back).

const el = {
  loading:    document.getElementById("state-loading"),
  none:       document.getElementById("state-none"),
  found:      document.getElementById("state-found"),
  title:      document.getElementById("info-title"),
  url:        document.getElementById("info-url"),
  time:       document.getElementById("info-time"),
  copy:       document.getElementById("btn-copy"),
  ping:       document.getElementById("btn-ping"),
  pingResult: document.getElementById("ping-result"),
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

// ── Stream detection state ────────────────────────────────────────────────────

async function init() {
  // 1. Get the active tab in the current window.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showState("none");
    return;
  }

  // 2. Look up any stored stream data for this tab.
  const key = `tab_${tab.id}`;
  const result = await chrome.storage.local.get(key);
  const data = result[key];

  if (!data) {
    showState("none");
    return;
  }

  // 3. Populate and show the "found" state.
  el.title.textContent = data.title || "Unknown";
  el.url.textContent   = data.m3u8Url;
  el.time.textContent  = formatTime(data.detectedAt);
  el.url.title = data.m3u8Url; // full URL on hover

  showState("found");
}

// Copy URL button — brief visual confirmation.
el.copy.addEventListener("click", () => {
  navigator.clipboard.writeText(el.url.textContent).then(() => {
    el.copy.textContent = "Copied!";
    el.copy.classList.add("copied");
    setTimeout(() => {
      el.copy.textContent = "Copy URL";
      el.copy.classList.remove("copied");
    }, 1500);
  });
});

// ── Native host ping ──────────────────────────────────────────────────────────

el.ping.addEventListener("click", async () => {
  el.ping.disabled = true;
  el.ping.textContent = "Pinging…";
  el.pingResult.className = "ping-result hidden";

  let result;
  try {
    // Send to service worker, which calls sendNativeMessage.
    // sendMessage rejects if there is no listener (service worker inactive).
    result = await chrome.runtime.sendMessage({ type: "PING_NATIVE" });
  } catch (e) {
    setPingResult(false, `Extension error: ${e.message}`);
    el.ping.disabled = false;
    el.ping.textContent = "Test Connection";
    return;
  }

  if (result.success) {
    const v = result.response?.version ?? "?";
    setPingResult(true, `Pong! Native host v${v} is reachable.`);
  } else {
    setPingResult(false, result.error);
  }

  el.ping.disabled = false;
  el.ping.textContent = "Test Connection";
});

function setPingResult(ok, text) {
  el.pingResult.textContent = text;
  el.pingResult.className = `ping-result ${ok ? "ping-ok" : "ping-err"}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
