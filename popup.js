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

async function refreshEntries() {
  const response = await chrome.runtime.sendMessage({
    type: "getEntries",
    tabId: currentTabId,
  });

  const entries = response.entries || [];
  countEl.textContent = entries.length;
  downloadAllBtn.disabled = entries.length === 0;

  hintEl.style.display = entries.length === 0 ? "" : "none";

  urlListEl.innerHTML = "";
  for (const entry of entries) {
    const div = document.createElement("div");
    div.className = "url-item";
    div.textContent = entry.name || `snapshot_${entry.uuid}.jpg`;
    urlListEl.appendChild(div);
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

saveDirBtn.addEventListener("click", async () => {
  const dir = sanitizeDir(parentDirInput.value.trim());
  parentDirInput.value = dir;
  await chrome.storage.sync.set({ parentDir: dir });
  setStatus("Settings saved", "success");
  setTimeout(() => setStatus(""), 2000);
});

downloadAllBtn.addEventListener("click", async () => {
  const settings = await chrome.storage.sync.get({ parentDir: "BrightHorizons" });

  clearFailures();
  setStatus("Downloading...");
  downloadAllBtn.disabled = true;

  const response = await chrome.runtime.sendMessage({
    type: "downloadAll",
    tabId: currentTabId,
    parentDir: settings.parentDir,
  });

  if (response.success) {
    const succeeded = response.results.filter((r) => r.success).length;
    const failedResults = response.results.filter((r) => !r.success);
    let msg = `Downloaded ${succeeded} image(s)`;
    if (failedResults.length > 0) msg += `, ${failedResults.length} failed`;
    setStatus(msg, failedResults.length > 0 ? "error" : "success");
    if (failedResults.length > 0) {
      showFailures(failedResults.map((r) => ({ url: r.uuid, error: r.error })));
    }
  } else {
    setStatus(response.error || "Download failed", "error");
  }

  await refreshEntries();
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
  const scanFailures = scanResponse.failures || [];

  if (scanFailures.length > 0) {
    showFailures(scanFailures);
  }

  let msg;
  if (total === 0) {
    msg = htmFound > 0
      ? `Opened ${htmFound} HTM page(s) — no valid images found`
      : (scanResponse.message || "No valid images found");
  } else {
    msg = `Found ${total} image(s)`;
    if (htmFound > 0) msg += ` across ${htmFound} HTM page(s)`;
    if (scanFailures.length === 0) msg += " — ready to download";
  }
  setStatus(msg, scanFailures.length > 0 ? "error" : "success");

  scanPageBtn.disabled = false;
  await refreshEntries();
});

clearAllBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "clearEntries",
    tabId: currentTabId,
  });
  clearFailures();
  setStatus("Cleared", "success");
  setTimeout(() => setStatus(""), 2000);
  await refreshEntries();
});

init();
