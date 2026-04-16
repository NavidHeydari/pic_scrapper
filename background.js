// Broad glob for Chrome's webRequest filter — catches all media traffic under /media/m/
const URL_PATTERN = "https://mbdgw.brighthorizons.com/api/parent/medias/*/media/m/*";

// Canonical validated download URL: versioned API path, any media type, strict RFC 4122 v1-v5 UUID, ?d=t suffix
const DOWNLOAD_URL_REGEX = /^https:\/\/mbdgw\.brighthorizons\.com\/api\/parent\/medias\/v[0-9]\/media\/m\/[^/]+\/[{(]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})[)}]?\?d=t$/;

// Resolve after a uniformly-random delay between minMs and maxMs (used during scan probing).
function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True when the stored filename looks like a video file.
function isVideoEntry(entry) {
  return /\.(mp4|webm|mov)$/i.test(entry.name || "");
}

// --- Content-type helpers ---

// Map a Content-Type header value to a file extension and broad media kind.
// Falls back to { ext: ".jpg", mediaKind: "image" } for unknown/missing types.
function contentTypeToExtension(contentType) {
  if (!contentType) return { ext: ".jpg", mediaKind: "image" };
  const ct = contentType.toLowerCase().split(";")[0].trim();
  const map = {
    "image/jpeg":                      { ext: ".jpg",  mediaKind: "image" },
    "image/png":                       { ext: ".png",  mediaKind: "image" },
    "image/webp":                      { ext: ".webp", mediaKind: "image" },
    "image/gif":                       { ext: ".gif",  mediaKind: "image" },
    "video/mp4":                       { ext: ".mp4",  mediaKind: "video" },
    "video/webm":                      { ext: ".webm", mediaKind: "video" },
    "video/quicktime":                 { ext: ".mov",  mediaKind: "video" },
    "application/x-mpegurl":          { ext: ".mp4",  mediaKind: "video" },
    "application/vnd.apple.mpegurl":  { ext: ".mp4",  mediaKind: "video" },
    "video/mp2t":                      { ext: ".mp4",  mediaKind: "video" },
  };
  return map[ct] || { ext: ".jpg", mediaKind: "image" };
}

// Issue a HEAD request to a canonical URL to retrieve its Content-Type.
// Returns the header value string, or null if the request fails.
async function probeContentType(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.headers.get("content-type");
  } catch {
    return null;
  }
}

// Normalise any raw BH media URL into the canonical download form.
// Returns { uuid, url, prefix } if the URL conforms, or null if it does not.
// Handles snapshot, observations, and any other media type under /media/m/.
function toDownloadUrl(rawUrl) {
  const clean = rawUrl.split("?")[0].split("#")[0];
  const m = clean.match(
    /^https:\/\/mbdgw\.brighthorizons\.com\/api\/parent\/medias\/(v[0-9])\/media\/m\/([^/]+)\/[{(]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})[)}]?$/i
  );
  if (!m) return null;
  const [, version, type, rawUuid] = m;
  const uuid = rawUuid.toLowerCase();
  const prefix = type.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  return { uuid, url: `https://mbdgw.brighthorizons.com/api/parent/medias/${version}/media/m/${type}/${uuid}?d=t`, prefix };
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

// --- Download tracking ---

// activeDownloads: chrome downloadId → { tabId, uuid }
const activeDownloads = new Map();

// downloadStatus: tabKey → Map<uuid, 'downloading'|'done'|'failed'>
const downloadStatus = new Map();

// Notify the popup of a download status change. Swallows errors if popup is closed.
function notifyProgress(tabId, uuid, status) {
  chrome.runtime.sendMessage({ type: "downloadProgress", tabId, uuid, status }).catch(() => {});
}

// Listen for Chrome download state changes and relay completion to the popup.
chrome.downloads.onChanged.addListener((delta) => {
  if (!activeDownloads.has(delta.id)) return;
  const { tabId, uuid } = activeDownloads.get(delta.id);

  let newStatus = null;
  if (delta.state?.current === "complete") {
    newStatus = "done";
    activeDownloads.delete(delta.id);

    // Remove the completed entry so it disappears from the list on next refresh.
    const key = `tab_${tabId}`;
    const entries = tabEntries.get(key) || [];
    const remaining = entries.filter((e) => e.uuid !== uuid);
    if (remaining.length > 0) {
      tabEntries.set(key, remaining);
    } else {
      tabEntries.delete(key);
    }
    persistTab(key);
    updateBadge(tabId, remaining.length);
  } else if (delta.state?.current === "interrupted") {
    newStatus = "failed";
    activeDownloads.delete(delta.id);
  }

  if (newStatus) {
    const key = `tab_${tabId}`;
    if (!downloadStatus.has(key)) downloadStatus.set(key, new Map());
    downloadStatus.get(key).set(uuid, newStatus);
    notifyProgress(tabId, uuid, newStatus);
  }
});

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.statusCode !== 200) return;

    const parsed = toDownloadUrl(details.url);
    if (!parsed) return;

    const tabId = details.tabId;
    if (tabId < 0) return;

    const contentTypeHeader = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    const { ext } = contentTypeToExtension(contentTypeHeader?.value);

    const { uuid, url, prefix } = parsed;
    const key = `tab_${tabId}`;

    const entries = tabEntries.get(key) || [];

    if (entries.some((e) => e.uuid === uuid)) return;

    entries.push({ uuid, url, name: `${prefix}_${uuid}${ext}`, timestamp: Date.now() });
    tabEntries.set(key, entries);
    persistTab(key);

    updateBadge(tabId, entries.length);
  },
  { urls: [URL_PATTERN] },
  ["responseHeaders"]
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

  if (message.type === "getDownloadStatus") {
    const key = `tab_${message.tabId}`;
    const statusMap = downloadStatus.get(key);
    const status = {};
    if (statusMap) {
      for (const [uuid, s] of statusMap) status[uuid] = s;
    }
    sendResponse({ status });
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

// Pacing constants — controls how we stagger download *requests* (not completions).
// Downloads themselves all run in parallel inside Chrome; these delays only throttle
// how quickly we hand new requests to Chrome, mimicking a human saving files one by one.
const PACE = {
  THINK_MIN:  500,    // pause before the very first request
  THINK_MAX: 1_500,
  IMAGE_MIN:  300,    // gap between consecutive image requests
  IMAGE_MAX:  900,
  VIDEO_MIN:  600,    // slightly longer gap before each video request
  VIDEO_MAX: 1_800,
  BATCH_MIN:  800,    // pause when switching from images to videos
  BATCH_MAX: 1_500,
};

// Initiate a single download. Returns immediately after Chrome accepts the request.
// Completion (or interruption) is reported asynchronously via chrome.downloads.onChanged.
async function startDownload(entry, tabId, dir, dateFolder, statusMap) {
  const filename = `${dir}/${dateFolder}/${entry.name || `media_${entry.uuid}`}`;
  statusMap.set(entry.uuid, "downloading");
  notifyProgress(tabId, entry.uuid, "downloading");

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
    activeDownloads.set(downloadId, { tabId, uuid: entry.uuid });
    return { uuid: entry.uuid, downloadId, success: true };
  } catch (err) {
    // Immediate failure — update status and notify popup now; won't appear via onChanged.
    statusMap.set(entry.uuid, "failed");
    notifyProgress(tabId, entry.uuid, "failed");
    return { uuid: entry.uuid, success: false, error: err.message };
  }
}

async function handleDownloadAll(tabId, parentDir, emailDate) {
  const key = `tab_${tabId}`;
  const entries = tabEntries.get(key) || [];

  if (entries.length === 0) {
    return { success: false, error: "No files to download" };
  }

  const dateFolder = (emailDate && /^\d{4}-\d{2}-\d{2}$/.test(emailDate))
    ? emailDate
    : new Date().toISOString().slice(0, 10);
  const dir = sanitizePath(parentDir || "BrightHorizons");

  // Separate images and videos — images download first.
  const images = entries.filter((e) => !isVideoEntry(e));
  const videos = entries.filter((e) => isVideoEntry(e));

  if (!downloadStatus.has(key)) downloadStatus.set(key, new Map());
  const statusMap = downloadStatus.get(key);

  // Stagger download *requests* with human-like gaps so we don't hammer the server.
  // Chrome runs the actual downloads in parallel; we only throttle when we hand each
  // request to Chrome. Images are initiated first, then videos.
  const results = [];

  // Brief think-time before the first request.
  await randomDelay(PACE.THINK_MIN, PACE.THINK_MAX);

  for (let i = 0; i < images.length; i++) {
    if (i > 0) await randomDelay(PACE.IMAGE_MIN, PACE.IMAGE_MAX);
    results.push(await startDownload(images[i], tabId, dir, dateFolder, statusMap));
  }

  if (images.length > 0 && videos.length > 0) {
    await randomDelay(PACE.BATCH_MIN, PACE.BATCH_MAX);
  }

  for (let i = 0; i < videos.length; i++) {
    if (i > 0) await randomDelay(PACE.VIDEO_MIN, PACE.VIDEO_MAX);
    results.push(await startDownload(videos[i], tabId, dir, dateFolder, statusMap));
  }

  return {
    success: true,
    initiated: entries.length,
    results,
  };
}

async function handleClearEntries(tabId) {
  const key = `tab_${tabId}`;

  // Cancel any in-flight Chrome downloads for this tab.
  for (const [downloadId, info] of activeDownloads) {
    if (info.tabId === tabId) {
      chrome.downloads.cancel(downloadId, () => {});
      activeDownloads.delete(downloadId);
    }
  }

  downloadStatus.delete(key);
  tabEntries.delete(key);
  persistTab(key);
  updateBadge(tabId, 0);
  return { success: true };
}

// --- DOM Scanning: inject into the active tab, find matching URLs, append ?d=t ---
// Broad pattern used during scanning — toDownloadUrl() validates and normalises afterwards
// Matches snapshot, observations, and any other media type under /media/m/
const SCAN_URL_REGEX = /https:\/\/mbdgw\.brighthorizons\.com\/api\/parent\/medias\/[^\s"'<>]+\/media\/m\/[^\s"'<>/]+\/[{(]?[0-9a-fA-F-]+[)}]?/gi;
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

    // Process direct media URLs found in the DOM.
    // HEAD probes are staggered to avoid a burst of simultaneous requests.
    for (const rawUrl of snapshotUrls) {
      const parsed = toDownloadUrl(rawUrl);
      if (!parsed) continue;
      const { uuid, url, prefix } = parsed;
      if (entries.some((e) => e.uuid === uuid)) continue;
      await randomDelay(300, 1_200);
      const contentType = await probeContentType(url);
      const { ext } = contentTypeToExtension(contentType);
      entries.push({ uuid, url, name: `${prefix}_${uuid}${ext}`, timestamp: Date.now() });
      added++;
    }

    // Fetch each HTM page and extract media URLs from it.
    for (const htmUrl of htmUrls) {
      const result = await fetchHtmAndExtractImages(htmUrl);
      if (!result.success) {
        failures.push({ url: htmUrl, error: result.error });
        continue;
      }
      for (const mediaUrl of result.urls) {
        const parsed = toDownloadUrl(mediaUrl);
        if (!parsed) continue;
        const { uuid, url, prefix } = parsed;
        if (entries.some((e) => e.uuid === uuid)) continue;
        await randomDelay(300, 1_200);
        const contentType = await probeContentType(url);
        const { ext } = contentTypeToExtension(contentType);
        entries.push({ uuid, url, name: `${prefix}_${uuid}${ext}`, timestamp: Date.now() });
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
