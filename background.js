// Broad glob for Chrome's webRequest filter — catches all snapshot traffic
const URL_PATTERN = "https://mbdgw.brighthorizons.com/api/parent/medias/*/media/m/snapshot/*";

// Canonical validated download URL: versioned API path, strict RFC 4122 v1-v5 UUID, ?d=t suffix
const DOWNLOAD_URL_REGEX = /^https:\/\/mbdgw\.brighthorizons\.com\/api\/parent\/medias\/v[0-9]\/media\/m\/snapshot\/[{(]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})[)}]?\?d=t$/;

// Normalise any raw BH snapshot URL into the canonical download form.
// Returns { uuid, url } if the URL conforms, or null if it does not.
function toDownloadUrl(rawUrl) {
  const clean = rawUrl.split("?")[0].split("#")[0];
  const m = clean.match(
    /^https:\/\/mbdgw\.brighthorizons\.com\/api\/parent\/medias\/(v[0-9])\/media\/m\/snapshot\/[{(]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})[)}]?$/i
  );
  if (!m) return null;
  const uuid = m[2].toLowerCase();
  return { uuid, url: `https://mbdgw.brighthorizons.com/api/parent/medias/${m[1]}/media/m/snapshot/${uuid}?d=t` };
}

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

    const parsed = toDownloadUrl(details.url);
    if (!parsed) return;

    const tabId = details.tabId;
    if (tabId < 0) return;

    const { uuid, url } = parsed;
    const key = `tab_${tabId}`;

    const entries = tabEntries.get(key) || [];

    if (entries.some((e) => e.uuid === uuid)) return;

    entries.push({ uuid, url, name: `snapshot_${uuid}.jpg`, timestamp: Date.now() });
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
    handleDownloadAll(message.tabId, message.parentDir, message.emailDate).then(sendResponse);
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

async function handleDownloadAll(tabId, parentDir, emailDate) {
  const key = `tab_${tabId}`;
  const entries = tabEntries.get(key) || [];

  if (entries.length === 0) {
    return { success: false, error: "No images to download" };
  }

  const dateFolder = (emailDate && /^\d{4}-\d{2}-\d{2}$/.test(emailDate))
    ? emailDate
    : new Date().toISOString().slice(0, 10);
  const dir = sanitizePath(parentDir || "BrightHorizons");
  const results = [];

  for (const entry of entries) {
    const filename = `${dir}/${dateFolder}/${entry.name || `snapshot_${entry.uuid}.jpg`}`;
    try {
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: entry.url, filename, conflictAction: "uniquify", saveAs: false },
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

// --- DOM Scanning: inject into the active tab, find matching URLs, append ?d=t ---
// Broad pattern used during scanning — toDownloadUrl() validates and normalises afterwards
const SCAN_URL_REGEX = /https:\/\/mbdgw\.brighthorizons\.com\/api\/parent\/medias\/[^\s"'<>]+\/media\/m\/snapshot\/[{(]?[0-9a-fA-F-]+[)}]?/gi;
const HTM_URL_REGEX = /https:\/\/mbdgw\.brighthorizons\.com\/[^\s"'<>\r\n]+\.htm(?:[?#][^\s"'<>\r\n]*)?/gi;

// Fetch an HTM page from the BH domain and extract image URLs from it
async function fetchHtmAndExtractImages(htmUrl) {
  try {
    const response = await fetch(htmUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const html = await response.text();
    const found = new Set();

    // Look for snapshot UUID URLs (existing pattern)
    const snapshotMatches = html.match(new RegExp(SCAN_URL_REGEX.source, "gi")) || [];
    for (const u of snapshotMatches) found.add(u.split("?")[0]);

    // Look for any direct .jpg/.jpeg URLs in the page
    const imgMatches = html.match(/https?:\/\/[^\s"'<>]+\.jpe?g(?:[?#][^\s"'<>]*)?/gi) || [];
    for (const u of imgMatches) found.add(u.split("?")[0]);

    return { success: true, urls: [...found], htmUrl };
  } catch (err) {
    return { success: false, error: err.message, htmUrl };
  }
}

async function handleScanTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scanDomForUrls,
      args: [SCAN_URL_REGEX.source, HTM_URL_REGEX.source],
    });

    const { snapshotUrls = [], htmUrls = [] } = results[0]?.result || {};

    if (snapshotUrls.length === 0 && htmUrls.length === 0) {
      return { success: true, added: 0, total: 0, message: "No matching URLs found in page" };
    }

    const key = `tab_${tabId}`;
    const entries = tabEntries.get(key) || [];
    let added = 0;
    const failures = [];

    // Process direct snapshot URLs found in the DOM
    for (const rawUrl of snapshotUrls) {
      const parsed = toDownloadUrl(rawUrl);
      if (!parsed) continue;
      const { uuid, url } = parsed;
      if (entries.some((e) => e.uuid === uuid)) continue;
      entries.push({ uuid, url, name: `snapshot_${uuid}.jpg`, timestamp: Date.now() });
      added++;
    }

    // Fetch each HTM page and extract image URLs from it
    for (const htmUrl of htmUrls) {
      const result = await fetchHtmAndExtractImages(htmUrl);
      if (!result.success) {
        failures.push({ url: htmUrl, error: result.error });
        continue;
      }
      for (const imageUrl of result.urls) {
        const parsed = toDownloadUrl(imageUrl);
        if (!parsed) continue;
        const { uuid, url } = parsed;
        if (entries.some((e) => e.uuid === uuid)) continue;
        entries.push({ uuid, url, name: `snapshot_${uuid}.jpg`, timestamp: Date.now() });
        added++;
      }
    }

    if (added > 0) {
      tabEntries.set(key, entries);
      persistTab(key);
      updateBadge(tabId, entries.length);
    }

    return {
      success: true,
      added,
      total: entries.length,
      htmFound: htmUrls.length,
      failures,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// This function runs inside the tab's page context
function scanDomForUrls(snapshotPatternSource, htmPatternSource) {
  const html = document.documentElement.outerHTML;
  return {
    snapshotUrls: [...new Set(html.match(new RegExp(snapshotPatternSource, "gi")) || [])],
    htmUrls:      [...new Set(html.match(new RegExp(htmPatternSource,      "gi")) || [])],
  };
}
