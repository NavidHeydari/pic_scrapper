const URL_PATTERN = "https://mbdgw.brighthorizons.com/api/parent/medias/*/media/m/snapshot/*";
const UUID_REGEX = /\/snapshot\/([0-9a-f-]+)/i;

// --- Step 1: In-memory Map as primary store (no races) ---
const tabEntries = new Map();

async function restoreFromStorage() {
  const data = await chrome.storage.session.get(null);
  for (const [key, entries] of Object.entries(data)) {
    if (key.startsWith("tab_") && Array.isArray(entries)) {
      tabEntries.set(key, entries);
    }
  }
}

function persistTab(key) {
  const entries = tabEntries.get(key);
  if (entries) {
    chrome.storage.session.set({ [key]: entries });
  } else {
    chrome.storage.session.remove(key);
  }
}

restoreFromStorage();

// --- Step 4: Path sanitization ---
function sanitizePath(dir) {
  return dir
    .replace(/\.\./g, "")           // remove path traversal
    .replace(/[<>:"|?*\\]/g, "_")   // replace illegal filename chars
    .replace(/^\/+|\/+$/g, "")      // strip leading/trailing slashes
    .replace(/\/\/+/g, "/")         // collapse multiple slashes
    .replace(/^_+|_+$/g, "")        // trim underscores left from sanitization
    || "BrightHorizons";            // fallback if empty after sanitization
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode !== 200) return;

    const match = details.url.match(UUID_REGEX);
    if (!match) return;

    const tabId = details.tabId;
    if (tabId < 0) return;

    const uuid = match[1];
    const key = `tab_${tabId}`;

    const entries = tabEntries.get(key) || [];

    if (entries.some((e) => e.uuid === uuid)) return;

    entries.push({ uuid, url: details.url, timestamp: Date.now() });
    tabEntries.set(key, entries);
    persistTab(key);

    updateBadge(tabId, entries.length);
  },
  { urls: [URL_PATTERN] }
);

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const key = `tab_${tabId}`;
  tabEntries.delete(key);
  persistTab(key);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  const key = `tab_${activeInfo.tabId}`;
  const entries = tabEntries.get(key) || [];
  updateBadge(activeInfo.tabId, entries.length);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getEntries") {
    handleGetEntries(message.tabId).then(sendResponse);
    return true;
  }

  if (message.type === "downloadAll") {
    handleDownloadAll(message.tabId, message.parentDir).then(sendResponse);
    return true;
  }

  if (message.type === "clearEntries") {
    handleClearEntries(message.tabId).then(sendResponse);
    return true;
  }
});

// --- Step 3: Refresh badge when popup opens (survives SW restart) ---
async function handleGetEntries(tabId) {
  const key = `tab_${tabId}`;

  // If in-memory map is empty, try restoring from storage (SW may have restarted)
  if (!tabEntries.has(key)) {
    const data = await chrome.storage.session.get(key);
    if (data[key] && Array.isArray(data[key])) {
      tabEntries.set(key, data[key]);
    }
  }

  const entries = tabEntries.get(key) || [];
  updateBadge(tabId, entries.length);
  return { entries };
}

// --- Step 2: Only remove successfully downloaded entries ---
async function handleDownloadAll(tabId, parentDir) {
  const key = `tab_${tabId}`;
  const entries = tabEntries.get(key) || [];

  if (entries.length === 0) {
    return { success: false, error: "No images to download" };
  }

  const today = new Date();
  const dateFolder = today.toISOString().slice(0, 10);
  const dir = sanitizePath(parentDir || "BrightHorizons");
  const results = [];

  for (const entry of entries) {
    const filename = `${dir}/${dateFolder}/snapshot_${entry.uuid}.jpg`;
    try {
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: entry.url, filename, conflictAction: "uniquify" },
          (id) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(id);
            }
          }
        );
      });
      results.push({ uuid: entry.uuid, downloadId, success: true });
    } catch (err) {
      results.push({ uuid: entry.uuid, success: false, error: err.message });
    }
  }

  const failedUuids = new Set(
    results.filter((r) => !r.success).map((r) => r.uuid)
  );
  const remaining = entries.filter((e) => failedUuids.has(e.uuid));

  if (remaining.length > 0) {
    tabEntries.set(key, remaining);
  } else {
    tabEntries.delete(key);
  }
  persistTab(key);
  updateBadge(tabId, remaining.length);

  return { success: true, results };
}

async function handleClearEntries(tabId) {
  const key = `tab_${tabId}`;
  tabEntries.delete(key);
  persistTab(key);
  updateBadge(tabId, 0);
  return { success: true };
}
