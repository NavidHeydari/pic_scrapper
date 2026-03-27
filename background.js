// Broad glob for Chrome's webRequest filter — catches all media traffic under /media/m/
const URL_PATTERN = "https://mbdgw.brighthorizons.com/api/parent/medias/*/media/m/*";

// Canonical validated download URL: versioned API path, any media type, strict RFC 4122 v1-v5 UUID, ?d=t suffix
const DOWNLOAD_URL_REGEX = /^https:\/\/mbdgw\.brighthorizons\.com\/api\/parent\/medias\/v[0-9]\/media\/m\/[^/]+\/[{(]?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})[)}]?\?d=t$/;

// --- Human-like pacing ---

// Resolve after a uniformly-random delay between minMs and maxMs.
function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fisher-Yates shuffle — randomises download order so sequential UUIDs
// are not fetched in the same order every time.
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

// Delay constants for human-like download pacing (all values in ms).
const PACE = {
  // Think-time before the very first download (user "decides" to save).
  THINK_MIN:        1_500,
  THINK_MAX:        4_000,
  // Gap between image downloads — simulates glancing at each photo.
  IMAGE_MIN:        2_000,
  IMAGE_MAX:        7_000,
  // Gap after a video — simulates watching a few seconds of it.
  VIDEO_MIN:       10_000,
  VIDEO_MAX:       25_000,
  // Occasional longer pause — simulates the user getting distracted.
  DISTRACTION_MIN: 20_000,
  DISTRACTION_MAX: 60_000,
  // Probability (0–1) that any given inter-item gap becomes a distraction pause.
  DISTRACTION_P:    0.12,
};

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
  const results = [];

  // Randomise order so consecutive runs don't hit the same UUIDs in sequence.
  const queue = shuffleInPlace([...entries]);

  // Brief pause before first request — simulates the user clicking Save.
  await randomDelay(PACE.THINK_MIN, PACE.THINK_MAX);

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    const filename = `${dir}/${dateFolder}/${entry.name || `media_${entry.uuid}`}`;

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

    // Pace between items — skip after the last one.
    if (i < queue.length - 1) {
      if (Math.random() < PACE.DISTRACTION_P) {
        // Simulates user leaving the page briefly, scrolling elsewhere, etc.
        await randomDelay(PACE.DISTRACTION_MIN, PACE.DISTRACTION_MAX);
      } else if (isVideoEntry(entry)) {
        // Simulates user watching a few seconds before moving on.
        await randomDelay(PACE.VIDEO_MIN, PACE.VIDEO_MAX);
      } else {
        // Simulates user glancing at the photo.
        await randomDelay(PACE.IMAGE_MIN, PACE.IMAGE_MAX);
      }
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
