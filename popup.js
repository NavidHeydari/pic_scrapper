const parentDirInput = document.getElementById("parentDir");
const saveDirBtn = document.getElementById("saveDir");
const countEl = document.getElementById("count");
const hintEl = document.getElementById("hint");
const urlListEl = document.getElementById("urlList");
const scanPageBtn = document.getElementById("scanPage");
const downloadAllBtn = document.getElementById("downloadAll");
const clearAllBtn = document.getElementById("clearAll");
const statusEl = document.getElementById("status");
const failureListEl = document.getElementById("failureList");

let currentTabId = null;

// Number of downloads still in flight (decremented on done/failed).
let pendingCount = 0;

function sanitizeDir(raw) {
  return raw
    .replace(/\.\./g, "")
    .replace(/[<>:"|?*\\]/g, "_")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/\/+/g, "/")
    .replace(/^_+|_+$/g, "")
    || "BrightHorizons";
}

async function init() {
  const settings = await chrome.storage.sync.get({ parentDir: "BrightHorizons" });
  parentDirInput.value = settings.parentDir;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;

  await refreshEntries();
}

// Build the per-entry status map from the background (for re-opens during active downloads).
async function fetchDownloadStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "getDownloadStatus",
      tabId: currentTabId,
    });
    return response?.status || {};
  } catch {
    return {};
  }
}

// Render a single entry row. statusMap is { [uuid]: 'downloading'|'done'|'failed' }.
function renderEntryRow(entry, statusMap) {
  const isVideo = /\.(mp4|webm|mov)$/i.test(entry.name || "");
  const entryStatus = statusMap[entry.uuid];

  const div = document.createElement("div");
  div.className = "url-item";
  div.dataset.uuid = entry.uuid;
  if (entryStatus) div.classList.add(entryStatus);

  const badge = document.createElement("span");
  badge.className = `media-badge ${isVideo ? "video" : "image"}`;
  badge.textContent = isVideo ? "VID" : "IMG";

  const nameSpan = document.createElement("span");
  nameSpan.className = "entry-name";
  nameSpan.textContent = entry.name || entry.uuid;

  div.appendChild(badge);
  div.appendChild(nameSpan);
  urlListEl.appendChild(div);
}

async function refreshEntries() {
  const response = await chrome.runtime.sendMessage({
    type: "getEntries",
    tabId: currentTabId,
  });

  const entries = response.entries || [];
  countEl.textContent = entries.length;
  downloadAllBtn.disabled = entries.length === 0 || pendingCount > 0;

  hintEl.style.display = entries.length === 0 && pendingCount === 0 ? "" : "none";

  // Fetch current download status so we can colour items correctly on re-open.
  const statusMap = await fetchDownloadStatus();

  // Rebuild the in-flight count from background state (handles popup re-opens).
  const inFlight = Object.values(statusMap).filter((s) => s === "downloading").length;
  if (inFlight > 0 && pendingCount === 0) {
    // Downloads are running but this popup session didn't start them — adopt the count.
    pendingCount = inFlight;
    downloadAllBtn.disabled = true;
    scanPageBtn.disabled = true;
    setStatus(`Downloading ${inFlight} file(s)...`);
  }

  urlListEl.innerHTML = "";
  for (const entry of entries) {
    renderEntryRow(entry, statusMap);
  }
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? ` ${type}` : "");
}

function showFailures(failures) {
  failureListEl.innerHTML = "";
  for (const f of failures) {
    const div = document.createElement("div");
    div.className = "failure-item";
    const urlSpan = document.createElement("span");
    urlSpan.className = "failure-url";
    urlSpan.textContent = f.url;
    const reasonSpan = document.createElement("span");
    reasonSpan.className = "failure-reason";
    reasonSpan.textContent = f.error;
    div.appendChild(urlSpan);
    div.appendChild(reasonSpan);
    failureListEl.appendChild(div);
  }
}

function clearFailures() {
  failureListEl.innerHTML = "";
}

// Called when all pending downloads have reached a terminal state.
function onAllDownloadsFinished() {
  const doneCount = urlListEl.querySelectorAll(".url-item.done").length;
  const failedCount = urlListEl.querySelectorAll(".url-item.failed").length;
  let msg = `Downloaded ${doneCount} file(s)`;
  if (failedCount > 0) msg += `, ${failedCount} failed`;
  setStatus(msg, failedCount > 0 ? "error" : "success");
  downloadAllBtn.disabled = false;
  scanPageBtn.disabled = false;
  refreshEntries();
}

// Listen for per-download progress notifications from the service worker.
// This fires even while the popup is open after a tab switch.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "downloadProgress" || message.tabId !== currentTabId) return;

  const { uuid, status } = message;

  // Update the list item colour.
  const item = urlListEl.querySelector(`[data-uuid="${uuid}"]`);
  if (item) {
    item.classList.remove("downloading", "done", "failed");
    item.classList.add(status);
  }

  // Decrement in-flight counter on terminal states.
  if (status === "done" || status === "failed") {
    pendingCount = Math.max(0, pendingCount - 1);
    if (pendingCount === 0) {
      onAllDownloadsFinished();
    }
  }
});

saveDirBtn.addEventListener("click", async () => {
  const dir = sanitizeDir(parentDirInput.value.trim());
  parentDirInput.value = dir;
  await chrome.storage.sync.set({ parentDir: dir });
  setStatus("Settings saved", "success");
  setTimeout(() => setStatus(""), 2000);
});

// Runs inside the tab's page context — extracts a YYYY-MM-DD date from the email view
function extractEmailDate() {
  // Helper: parse any recognisable date string → "YYYY-MM-DD", or null.
  function parseText(text) {
    const t = text.trim();
    if (!t) return null;

    // YYYY-MM-DD
    let m = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (m) return m[1];

    // "Month DD, YYYY" or "Mon DD, YYYY"
    const months = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
    m = t.match(new RegExp(`(${months})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"));
    if (m) {
      const d = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }

    // MM/DD/YYYY
    m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (m) {
      const d = new Date(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }

    return null;
  }

  // 1. Primary: any element whose class list contains a class ending in "-report-date".
  for (const el of document.querySelectorAll("[class]")) {
    if ([...el.classList].some((c) => c.endsWith("-report-date"))) {
      const date = parseText(el.textContent);
      if (date) return date;
    }
  }

  // 2. Fallback: <time datetime="YYYY-MM-DD...">
  for (const el of document.querySelectorAll("time[datetime]")) {
    const m = el.getAttribute("datetime").match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }

  // 3. Fallback: walk all text nodes for a recognisable date string.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const date = parseText(node.textContent);
    if (date) return date;
  }

  return null;
}

downloadAllBtn.addEventListener("click", async () => {
  const settings = await chrome.storage.sync.get({ parentDir: "BrightHorizons" });

  clearFailures();

  // Capture the count now, before any downloads start, to avoid a race with
  // downloadProgress messages arriving before the response comes back.
  const totalEntries = parseInt(countEl.textContent, 10) || 0;
  pendingCount = totalEntries;

  setStatus("Starting downloads...");
  downloadAllBtn.disabled = true;
  scanPageBtn.disabled = true;

  let emailDate = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      func: extractEmailDate,
    });
    emailDate = results[0]?.result || null;
  } catch (_) {
    // scripting not available on this tab — fall back to today's date
  }

  const response = await chrome.runtime.sendMessage({
    type: "downloadAll",
    tabId: currentTabId,
    parentDir: settings.parentDir,
    emailDate,
  });

  if (!response.success) {
    pendingCount = 0;
    setStatus(response.error || "Download failed", "error");
    downloadAllBtn.disabled = false;
    scanPageBtn.disabled = false;
    return;
  }

  // Recalibrate in case the actual initiated count differs (e.g. entries changed).
  pendingCount = response.initiated;
  setStatus(`Downloading ${response.initiated} file(s)...`);

  if (response.initiated === 0) {
    onAllDownloadsFinished();
  }
});

scanPageBtn.addEventListener("click", async () => {
  scanPageBtn.disabled = true;
  downloadAllBtn.disabled = true;
  clearFailures();
  setStatus("Scanning page...");

  const scanResponse = await chrome.runtime.sendMessage({
    type: "scanTab",
    tabId: currentTabId,
  });

  if (!scanResponse.success) {
    setStatus(scanResponse.error || "Scan failed", "error");
    scanPageBtn.disabled = false;
    await refreshEntries();
    return;
  }

  const total = scanResponse.total || 0;
  const htmFound = scanResponse.htmFound || 0;
  const failures = scanResponse.failures || [];

  if (failures.length > 0) showFailures(failures);

  let msg;
  if (total === 0) {
    msg = htmFound > 0
      ? `Opened ${htmFound} HTM page(s) but found no media`
      : (scanResponse.message || "No media found");
  } else {
    msg = `Found ${total} file(s)`;
    if (htmFound > 0) msg += ` across ${htmFound} HTM page(s)`;
  }
  setStatus(msg, failures.length > 0 ? "error" : "success");

  scanPageBtn.disabled = false;
  await refreshEntries();
});

clearAllBtn.addEventListener("click", async () => {
  pendingCount = 0;
  await chrome.runtime.sendMessage({
    type: "clearEntries",
    tabId: currentTabId,
  });
  clearFailures();
  setStatus("Cleared", "success");
  setTimeout(() => setStatus(""), 2000);
  downloadAllBtn.disabled = false;
  scanPageBtn.disabled = false;
  await refreshEntries();
});

init();
