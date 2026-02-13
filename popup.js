const parentDirInput = document.getElementById("parentDir");
const saveDirBtn = document.getElementById("saveDir");
const countEl = document.getElementById("count");
const hintEl = document.getElementById("hint");
const urlListEl = document.getElementById("urlList");
const scanPageBtn = document.getElementById("scanPage");
const downloadAllBtn = document.getElementById("downloadAll");
const clearAllBtn = document.getElementById("clearAll");
const statusEl = document.getElementById("status");

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
    div.textContent = `snapshot_${entry.uuid}.jpg`;
    urlListEl.appendChild(div);
  }
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = "status" + (type ? ` ${type}` : "");
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

  setStatus("Downloading...");
  downloadAllBtn.disabled = true;

  const response = await chrome.runtime.sendMessage({
    type: "downloadAll",
    tabId: currentTabId,
    parentDir: settings.parentDir,
  });

  if (response.success) {
    const succeeded = response.results.filter((r) => r.success).length;
    const failed = response.results.filter((r) => !r.success).length;
    let msg = `Downloaded ${succeeded} image(s)`;
    if (failed > 0) msg += `, ${failed} failed`;
    setStatus(msg, failed > 0 ? "error" : "success");
  } else {
    setStatus(response.error || "Download failed", "error");
  }

  await refreshEntries();
});

scanPageBtn.addEventListener("click", async () => {
  scanPageBtn.disabled = true;
  downloadAllBtn.disabled = true;
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
  if (total === 0) {
    setStatus(scanResponse.message || "No images found", "success");
    scanPageBtn.disabled = false;
    await refreshEntries();
    return;
  }

  // Automatically download all collected images
  setStatus(`Found ${total} image(s), downloading...`);
  const settings = await chrome.storage.sync.get({ parentDir: "BrightHorizons" });

  const dlResponse = await chrome.runtime.sendMessage({
    type: "downloadAll",
    tabId: currentTabId,
    parentDir: settings.parentDir,
  });

  if (dlResponse.success) {
    const succeeded = dlResponse.results.filter((r) => r.success).length;
    const failed = dlResponse.results.filter((r) => !r.success).length;
    let msg = `Downloaded ${succeeded} image(s)`;
    if (failed > 0) msg += `, ${failed} failed`;
    setStatus(msg, failed > 0 ? "error" : "success");
  } else {
    setStatus(dlResponse.error || "Download failed", "error");
  }

  scanPageBtn.disabled = false;
  await refreshEntries();
});

clearAllBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "clearEntries",
    tabId: currentTabId,
  });
  setStatus("Cleared", "success");
  setTimeout(() => setStatus(""), 2000);
  await refreshEntries();
});

init();
