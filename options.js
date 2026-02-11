const parentDirInput = document.getElementById("parentDir");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

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
}

saveBtn.addEventListener("click", async () => {
  const dir = sanitizeDir(parentDirInput.value.trim());
  parentDirInput.value = dir;
  await chrome.storage.sync.set({ parentDir: dir });
  statusEl.textContent = "Settings saved.";
  setTimeout(() => { statusEl.textContent = ""; }, 2000);
});

init();
