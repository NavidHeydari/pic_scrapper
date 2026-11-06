// Expired-photo refresh.
//
// Bright Horizons emails link to media that expires after a while. An expired media URL serves an
// HTML page with a "click here" link (/media/m/refresh/<id>) instead of the image; following that
// link makes BH email a fresh copy of the photo.
//
// Flow: collectEmailImages (injected into the email tab) reports every <img> with its load result,
// classifyEmailImages picks the BH media that failed to load, and refreshOne opens each media page
// in a background tab, clicks its refresh link via clickRefreshLink, then closes the tab.
//
// Loaded into the service worker by importScripts() in background.js, so it shares that scope
// (toDownloadUrl, randomDelay).

// Human-like pacing for refresh requests — every refresh triggers a new email from BH.
const REFRESH_PACE = {
  OPEN_MIN:  1_200,   // gap before opening each expired page
  OPEN_MAX: 10_000,
  CLICK_MIN: 1_200,   // pause on the page before clicking "click here"
  CLICK_MAX: 10_000,
};
const IMAGE_SETTLE_TIMEOUT_MS = 8_000;   // max wait for an email image to load or fail
const REFRESH_TAB_TIMEOUT_MS = 30_000;   // max wait for a refresh tab to finish loading
const REFRESHED_STORAGE_KEY = "refreshedUuids";

// Chrome kills a service worker after 30 s without extension events/API calls; a run spends up to
// ~30 s waiting on a single tab, so ping a cheap API on this interval while a run is in progress.
const KEEPALIVE_INTERVAL_MS = 20_000;

// Gmail's "sun" placeholder shown in place of a BH image it could not fetch.
const PLACEHOLDER_SIZE = 200;

// UUIDs whose refresh was already requested, so a second run does not trigger duplicate emails.
const refreshedUuids = new Set();
const refreshedReady = chrome.storage.session.get(REFRESHED_STORAGE_KEY).then((data) => {
  for (const uuid of data[REFRESHED_STORAGE_KEY] || []) refreshedUuids.add(uuid);
});

// The current (or last) refresh run: { tabId, running, total, alreadyRequested, results }.
let refreshState = null;
// Promise for the run in progress (lets tests await completion).
let refreshTask = null;

const log = (...args) => console.log("[BH refresh]", ...args);

// An expired media URL serves an HTML page rather than the media itself.
function isExpiredContentType(contentType) {
  return /^\s*text\/html\b/i.test(contentType || "");
}

// Gmail proxies images as https://ciN.googleusercontent.com/...#<original url>.
// Returns the original URL, or src unchanged when it is not a proxied URL.
function extractOriginalUrl(src) {
  if (typeof src !== "string") return "";
  const i = src.indexOf("#");
  if (i === -1) return src;
  let tail = src.slice(i + 1);
  try {
    tail = decodeURIComponent(tail);
  } catch {
    // Malformed escape sequence — use the fragment as-is.
  }
  return /^https?:\/\//i.test(tail) ? tail : src;
}

// Unavailable = failed to load, or Gmail's 200×200 placeholder standing in for a BH image.
function isUnavailableImage(img, isBhMedia) {
  if (!img.naturalWidth) return true;
  return isBhMedia && img.naturalWidth === PLACEHOLDER_SIZE && img.naturalHeight === PLACEHOLDER_SIZE;
}

// Classify the images reported by collectEmailImages.
// Returns { total, unavailable, expired: [{ uuid, prefix, pageUrl }] }, de-duped by UUID.
function classifyEmailImages(images) {
  const expired = [];
  const seen = new Set();
  let unavailable = 0;

  for (const img of images || []) {
    const parsed = toDownloadUrl(extractOriginalUrl(img.src));
    if (!isUnavailableImage(img, !!parsed)) continue;
    unavailable++;
    if (!parsed || seen.has(parsed.uuid)) continue;
    seen.add(parsed.uuid);
    // Open the page without ?d=t so BH renders the expired notice instead of a download.
    expired.push({ uuid: parsed.uuid, prefix: parsed.prefix, pageUrl: parsed.url.replace(/\?d=t$/, "") });
  }

  return { total: (images || []).length, unavailable, expired };
}

function persistRefreshed() {
  chrome.storage.session.set({ [REFRESHED_STORAGE_KEY]: [...refreshedUuids] });
}

function notifyRefreshProgress(tabId, uuid, status, done, total) {
  chrome.runtime.sendMessage({ type: "refreshProgress", tabId, uuid, status, done, total }).catch(() => {});
}

// Snapshot of a refresh run for the popup.
function summarizeRefresh(state) {
  const count = (status) => state.results.filter((r) => r.status === status).length;
  return {
    tabId: state.tabId,
    running: state.running,
    done: state.results.length,
    total: state.total,
    requested: count("clicked"),
    available: count("available"),
    failed: count("failed"),
    alreadyRequested: state.alreadyRequested,
    results: state.results,
  };
}

// Resolve once the tab finishes loading (or after timeoutMs). With requireLoading, a "complete"
// only counts after a fresh "loading" — i.e. waits for a new navigation rather than the current page.
// Returns { done: Promise<boolean>, stop() }; done resolves true on load, false on timeout/stop.
function watchTabLoad(tabId, timeoutMs, { requireLoading = false } = {}) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let sawLoading = false;
  let settled = false;

  const listener = (id, changeInfo) => {
    if (id !== tabId) return;
    if (changeInfo.status === "loading") sawLoading = true;
    if (changeInfo.status === "complete" && (sawLoading || !requireLoading)) settle(true);
  };
  const timer = setTimeout(() => settle(false), timeoutMs);

  function settle(result) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(listener);
    finish(result);
  }

  chrome.tabs.onUpdated.addListener(listener);
  if (!requireLoading) {
    // The tab may have finished loading before the listener was attached.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") settle(true);
    }).catch(() => settle(false));
  }

  return { done, stop: () => settle(false) };
}

// Open one expired media page in a background tab, click its refresh link, and close the tab.
// Returns { status: "clicked" | "available" | "failed", error? }.
async function refreshOne(item) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: item.pageUrl, active: false });
    tabId = tab.id;
    if (!(await watchTabLoad(tabId, REFRESH_TAB_TIMEOUT_MS).done)) {
      return { status: "failed", error: "Page did not load" };
    }

    // Watch for the navigation the click causes before clicking, so it cannot be missed.
    const navigation = watchTabLoad(tabId, REFRESH_TAB_TIMEOUT_MS, { requireLoading: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickRefreshLink,
      args: [REFRESH_PACE.CLICK_MIN, REFRESH_PACE.CLICK_MAX],
    });
    const status = injection?.result?.status;

    if (status === "clicked") {
      // Keep the tab open until the refresh request has gone through.
      await navigation.done;
      return { status };
    }
    navigation.stop();
    return status === "available" ? { status } : { status: "failed", error: "No result from page" };
  } catch (err) {
    return { status: "failed", error: err.message };
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function findExpiredInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectEmailImages,
    args: [IMAGE_SETTLE_TIMEOUT_MS],
  });
  return classifyEmailImages(results[0]?.result || []);
}

// Report the expired media in the tab's open email without refreshing anything.
async function handleFindExpired(tabId) {
  try {
    await refreshedReady;
    const { total, unavailable, expired } = await findExpiredInTab(tabId);
    const pending = expired.filter((e) => !refreshedUuids.has(e.uuid));
    return {
      success: true,
      total,
      unavailable,
      expired: pending,
      alreadyRequested: expired.length - pending.length,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Find the expired media in the tab's open email and start requesting a refresh for each.
// Replies once the run has started: a run takes ~15 s per photo, and keeping the message open for
// all of it would exceed Chrome's 5-minute per-event limit, killing the worker mid-run.
// Progress arrives as "refreshProgress" messages and the outcome as "refreshDone".
async function handleRefreshExpired(tabId) {
  if (refreshState?.running) return { success: false, error: "A refresh is already running" };
  refreshState = { tabId, running: true, total: 0, alreadyRequested: 0, results: [] };

  const found = await handleFindExpired(tabId);
  if (!found.success) {
    refreshState = null;
    return found;
  }

  refreshState.total = found.expired.length;
  refreshState.alreadyRequested = found.alreadyRequested;
  log(`starting: ${found.expired.length} expired, ${found.alreadyRequested} already requested`);
  refreshTask = runRefresh(refreshState, found.expired);
  return { success: true, started: true, total: refreshState.total, alreadyRequested: found.alreadyRequested };
}

// Request a refresh for each expired item, one at a time with human-like gaps.
async function runRefresh(state, pending) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), KEEPALIVE_INTERVAL_MS);
  try {
    for (const [i, item] of pending.entries()) {
      await randomDelay(REFRESH_PACE.OPEN_MIN, REFRESH_PACE.OPEN_MAX);
      notifyRefreshProgress(state.tabId, item.uuid, "opening", i, pending.length);
      const result = await refreshOne(item);
      log(`${i + 1}/${pending.length} ${item.uuid}: ${result.status}${result.error ? ` (${result.error})` : ""}`);
      if (result.status === "clicked") {
        refreshedUuids.add(item.uuid);
        persistRefreshed();
      }
      state.results.push({ uuid: item.uuid, url: item.pageUrl, ...result });
      notifyRefreshProgress(state.tabId, item.uuid, result.status, i + 1, pending.length);
    }
  } finally {
    clearInterval(keepAlive);
    state.running = false;
    const summary = summarizeRefresh(state);
    log(`done: ${summary.requested} requested, ${summary.available} available, ${summary.failed} failed`);
    chrome.runtime.sendMessage({ type: "refreshDone", ...summary }).catch(() => {});
  }
}

// Current run state for a popup that was (re)opened mid-run; null when no run happened.
function handleGetRefreshStatus() {
  return { status: refreshState ? summarizeRefresh(refreshState) : null };
}

// --- Injected functions (serialized into a tab: must not reference anything outside themselves) ---

// Runs in the email tab — waits for each email image to load or fail, then reports its size.
// Uses Gmail's message-body containers when present, otherwise every image on the page.
async function collectEmailImages(settleTimeoutMs) {
  const bodies = document.querySelectorAll('div[role="main"] .a3s');
  const imgs = bodies.length > 0
    ? [...bodies].flatMap((b) => [...b.querySelectorAll("img")])
    : [...document.querySelectorAll("img")];

  await Promise.all(imgs.map((img) => img.complete ? null : new Promise((resolve) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, settleTimeoutMs);
  })));

  return imgs.map((img) => ({
    src: img.src,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  }));
}

// Runs in an expired media page — clicks the "click here" refresh link like a person would:
// pause, scroll, hover, press, click. Returns { status: "clicked" | "available" }.
async function clickRefreshLink(minDelayMs, maxDelayMs) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const link = [...document.querySelectorAll("a")].find((a) => /\/media\/m\/refresh\//.test(a.href));
  if (!link) return { status: "available" };

  await sleep(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
  link.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(300 + Math.random() * 700);

  const r = link.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, view: window,
    clientX: r.left + Math.random() * r.width, clientY: r.top + Math.random() * r.height,
  };
  for (const type of ["mouseover", "mouseenter", "mousemove"]) link.dispatchEvent(new MouseEvent(type, opts));
  await sleep(150 + Math.random() * 450);
  link.dispatchEvent(new MouseEvent("mousedown", opts));
  await sleep(60 + Math.random() * 120);
  link.dispatchEvent(new MouseEvent("mouseup", opts));
  link.click();
  return { status: "clicked" };
}
