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

  if (message.type === "scanTab") {
    handleScanTab(message.tabId).then(sendResponse);
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

// --- DOM Scanning: inject into the active tab, find matching URLs, append ?t=d ---
const SCAN_URL_REGEX = /https:\/\/mbdgw\.brighthorizons\.com\/api\/parent\/medias\/[^"'\s]+\/media\/m\/snapshot\/[0-9a-f-]+/gi;

async function handleScanTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scanDomForUrls,
      args: [SCAN_URL_REGEX.source],
    });

    const foundUrls = results[0]?.result || [];
    if (foundUrls.length === 0) {
      return { success: true, added: 0, message: "No matching URLs found in page" };
    }

    const key = `tab_${tabId}`;
    const entries = tabEntries.get(key) || [];
    let added = 0;

    for (const rawUrl of foundUrls) {
      // Strip any existing query string and append ?t=d
      const cleanUrl = rawUrl.split("?")[0];
      const downloadUrl = cleanUrl + "?t=d";

      const uuidMatch = cleanUrl.match(/\/snapshot\/([0-9a-f-]+)/i);
      if (!uuidMatch) continue;

      const uuid = uuidMatch[1];
      if (entries.some((e) => e.uuid === uuid)) continue;

      entries.push({ uuid, url: downloadUrl, timestamp: Date.now() });
      added++;
    }

    if (added > 0) {
      tabEntries.set(key, entries);
      persistTab(key);
      updateBadge(tabId, entries.length);
    }

    return { success: true, added, total: entries.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// This function runs inside the tab's page context
function scanDomForUrls(patternSource) {
  const regex = new RegExp(patternSource, "gi");
  const urls = new Set();

  // Scan all elements for src, href, data-src, data-original, poster, srcset
  const attrs = ["src", "href", "data-src", "data-original", "poster"];
  for (const el of document.querySelectorAll("*")) {
    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const matches = val.match(regex);
        if (matches) matches.forEach((m) => urls.add(m));
      }
    }
    // Check srcset (contains URLs with descriptors)
    const srcset = el.getAttribute("srcset");
    if (srcset) {
      const matches = srcset.match(regex);
      if (matches) matches.forEach((m) => urls.add(m));
    }
    // Check inline style for background-image urls
    const style = el.getAttribute("style");
    if (style) {
      const matches = style.match(regex);
      if (matches) matches.forEach((m) => urls.add(m));
    }
  }

  // Also scan the full page HTML as a fallback (catches URLs in scripts, data attrs, etc.)
  const htmlMatches = document.documentElement.outerHTML.match(regex);
  if (htmlMatches) htmlMatches.forEach((m) => urls.add(m));

  return [...urls];
}
