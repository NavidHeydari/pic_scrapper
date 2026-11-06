const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPopup } = require("./helpers/popup-harness");

const TAB = 7; // the active tab id the popup harness reports
const EXPIRED = [{ uuid: "a", pageUrl: "https://x/a" }, { uuid: "b", pageUrl: "https://x/b" }];

// A worker that answers findExpired with two expired photos and starts a refresh run.
function healthyWorker(message) {
  if (message.type === "getRefreshStatus") return { status: null };
  if (message.type === "findExpired") return { success: true, total: 5, unavailable: 2, expired: EXPIRED, alreadyRequested: 0 };
  if (message.type === "refreshExpired") return { success: true, started: true, total: 2, alreadyRequested: 0 };
  throw new Error(`unexpected ${message.type}`);
}

// Regression: an unreachable worker used to leave the popup on "Checking email images..." forever.
test("Find Expired shows an error and re-enables the button when the worker is unreachable", async () => {
  const popup = await loadPopup((message) => {
    if (message.type === "getRefreshStatus") return { status: null };
    throw new Error("The message port closed before a response was received.");
  });

  await popup.click("refreshExpired");

  assert.match(popup.el("status").textContent, /Lost contact with the extension .*message port closed/);
  assert.equal(popup.el("status").className, "status error");
  assert.equal(popup.el("refreshExpired").disabled, false);
  assert.equal(popup.el("refreshExpired").textContent, "Find Expired Photos");
});

test("Find Expired shows an error when an outdated worker does not answer the message", async () => {
  const popup = await loadPopup(() => undefined);

  await popup.click("refreshExpired");

  assert.match(popup.el("status").textContent, /No response from the extension/);
  assert.equal(popup.el("refreshExpired").disabled, false);
});

test("Find Expired asks for confirmation before requesting refreshes", async () => {
  const popup = await loadPopup(healthyWorker);

  await popup.click("refreshExpired");

  assert.equal(popup.el("refreshExpired").textContent, "Request 2 Refresh(es)");
  assert.equal(popup.el("refreshExpired").classList.contains("confirm"), true);
  assert.match(popup.el("status").textContent, /2 expired photo\(s\)\. Each refresh sends you a new email\./);
  assert.equal(popup.sent.filter((m) => m.type === "refreshExpired").length, 0);
});

test("Requesting refreshes shows live progress and the final summary", async () => {
  const popup = await loadPopup(healthyWorker);
  await popup.click("refreshExpired");
  await popup.click("refreshExpired");

  const btn = popup.el("refreshExpired");
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, "Refreshing...");
  assert.equal(popup.el("status").textContent, "Requested 0/2 refresh(es)...");

  popup.push({ type: "refreshProgress", tabId: TAB, uuid: "a", status: "opening", done: 0, total: 2 });
  assert.equal(popup.el("status").textContent, "Opening photo 1/2 in a background tab...");
  popup.push({ type: "refreshProgress", tabId: TAB, uuid: "a", status: "clicked", done: 1, total: 2 });
  assert.equal(popup.el("status").textContent, "Requested 1/2 refresh(es)...");

  popup.push({
    type: "refreshDone", tabId: TAB, running: false, done: 2, total: 2,
    requested: 1, available: 0, failed: 1, alreadyRequested: 0,
    results: [{ uuid: "a", status: "clicked" }, { uuid: "b", url: "https://x/b", status: "failed", error: "Page did not load" }],
  });
  assert.equal(popup.el("status").textContent, "Requested 1 refresh(es) — check your email, 1 failed");
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "Find Expired Photos");
  assert.equal(popup.el("failureList").children.length, 1);
});

test("Progress for another tab is ignored", async () => {
  const popup = await loadPopup(healthyWorker);
  await popup.click("refreshExpired");
  await popup.click("refreshExpired");

  popup.push({ type: "refreshDone", tabId: 99, requested: 2, available: 0, failed: 0, results: [] });
  assert.equal(popup.el("refreshExpired").textContent, "Refreshing...");
});

test("Requesting refreshes shows an error and resets when the worker is unreachable", async () => {
  const popup = await loadPopup((message) => {
    if (message.type === "refreshExpired") return Promise.reject(new Error("Extension context invalidated."));
    return healthyWorker(message);
  });
  await popup.click("refreshExpired");
  await popup.click("refreshExpired");

  assert.match(popup.el("status").textContent, /Lost contact with the extension .*context invalidated/);
  assert.equal(popup.el("refreshExpired").disabled, false);
  assert.equal(popup.el("refreshExpired").textContent, "Find Expired Photos");
});

test("A popup reopened mid-run shows the run in progress", async () => {
  const popup = await loadPopup((message) => {
    if (message.type === "getRefreshStatus") return { status: { running: true, tabId: TAB, done: 3, total: 8 } };
    return healthyWorker(message);
  });

  assert.equal(popup.el("refreshExpired").disabled, true);
  assert.equal(popup.el("refreshExpired").textContent, "Refreshing...");
  assert.equal(popup.el("status").textContent, "Requested 3/8 refresh(es)...");
});

test("A popup still opens when the worker cannot report refresh status", async () => {
  const popup = await loadPopup((message) => {
    if (message.type === "getRefreshStatus") throw new Error("Could not establish connection.");
    return healthyWorker(message);
  });

  assert.equal(popup.el("refreshExpired").disabled, false);
  assert.notEqual(popup.el("refreshExpired").textContent, "Refreshing...");
});
