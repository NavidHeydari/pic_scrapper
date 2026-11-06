const test = require("node:test");
const assert = require("node:assert/strict");
const { loadExtension, plain } = require("./helpers/harness");

const UUID_A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const UUID_B = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const BH = "https://mbdgw.brighthorizons.com/api/parent/medias/v1/media/m";
const snapshot = (uuid) => `${BH}/snapshot/${uuid}`;
const gmailProxy = (url) => `https://ci3.googleusercontent.com/meips/ADKq_Nb3x=s0-d-e1-ft#${url}`;

const EMAIL_TAB = 7;

// An email with two expired BH photos, one that still loads, and a broken non-BH image.
const EMAIL_IMAGES = [
  { src: gmailProxy(snapshot(UUID_A)), naturalWidth: 200, naturalHeight: 200 },
  { src: gmailProxy(snapshot(UUID_B)), naturalWidth: 0, naturalHeight: 0 },
  { src: gmailProxy(snapshot("0d9c8b7a-6f5e-4d3c-8b2a-190807060504")), naturalWidth: 800, naturalHeight: 600 },
  { src: "https://example.com/pixel.gif", naturalWidth: 0, naturalHeight: 0 },
];

// Expired page: has a refresh link, and clicking it navigates the tab.
const clickAndNavigate = (opts, h) => {
  h.navigate(opts.target.tabId);
  return { status: "clicked" };
};

function setup({ images = EMAIL_IMAGES, click = clickAndNavigate, ...rest } = {}) {
  return loadExtension({
    scripts: { collectEmailImages: () => images, clickRefreshLink: click },
    ...rest,
  });
}

// --- findExpired ---

test("findExpired reports expired BH photos in the open email without opening tabs", async () => {
  const h = setup();
  const res = plain(await h.send({ type: "findExpired", tabId: EMAIL_TAB }));

  assert.equal(res.success, true);
  assert.equal(res.total, 4);
  assert.equal(res.unavailable, 3);
  assert.deepEqual(res.expired.map((e) => e.uuid), [UUID_A, UUID_B]);
  assert.equal(res.alreadyRequested, 0);
  assert.equal(h.createdTabs.length, 0);
  assert.deepEqual(h.executeScriptCalls[0], { name: "collectEmailImages", target: { tabId: EMAIL_TAB }, args: [8000] });
});

test("findExpired returns an error when the page cannot be scripted", async () => {
  const h = loadExtension({
    scripts: { collectEmailImages: () => { throw new Error("Cannot access a chrome:// URL"); } },
  });
  const res = plain(await h.send({ type: "findExpired", tabId: EMAIL_TAB }));
  assert.deepEqual(res, { success: false, error: "Cannot access a chrome:// URL" });
});

test("findExpired skips photos whose refresh was requested before a service worker restart", async () => {
  const h = setup({ session: { refreshedUuids: [UUID_A] } });
  const res = plain(await h.send({ type: "findExpired", tabId: EMAIL_TAB }));
  assert.deepEqual(res.expired.map((e) => e.uuid), [UUID_B]);
  assert.equal(res.alreadyRequested, 1);
});

// --- refreshExpired ---

// Start a run and wait for it to finish; returns { started, done } — the immediate reply and
// the "refreshDone" summary pushed to the popup at the end.
async function runRefresh(h) {
  const started = plain(await h.send({ type: "refreshExpired", tabId: EMAIL_TAB }));
  await h.run("refreshTask");
  const done = h.sentMessages.filter((m) => m.type === "refreshDone").pop();
  return { started, done };
}

// Regression: the whole run used to happen inside one message handler, so a run over Chrome's
// 5-minute per-event limit killed the service worker and left the popup waiting forever.
test("refreshExpired replies as soon as the run starts, before any tab is opened", async () => {
  const h = setup();
  const res = plain(await h.send({ type: "refreshExpired", tabId: EMAIL_TAB }));

  assert.deepEqual(res, { success: true, started: true, total: 2, alreadyRequested: 0 });
  assert.equal(h.createdTabs.length, 0);
});

test("refreshExpired keeps the service worker alive during the run and stops afterwards", async () => {
  const h = setup();
  await h.send({ type: "refreshExpired", tabId: EMAIL_TAB });

  assert.equal(h.intervals.size, 1);
  h.tick();
  assert.equal(h.platformInfoCalls, 1);

  await h.run("refreshTask");
  assert.equal(h.intervals.size, 0);
});

test("refreshExpired opens each expired page in a background tab, clicks refresh, and closes it", async () => {
  const h = setup();
  const { done } = await runRefresh(h);

  assert.equal(done.running, false);
  assert.equal(done.tabId, EMAIL_TAB);
  assert.equal(done.requested, 2);
  assert.equal(done.available, 0);
  assert.equal(done.failed, 0);
  assert.deepEqual(h.createdTabs.map((t) => [t.url, t.active]), [
    [snapshot(UUID_A), false],
    [snapshot(UUID_B), false],
  ]);
  assert.deepEqual(h.removedTabs, h.createdTabs.map((t) => t.id));

  const clicks = h.executeScriptCalls.filter((c) => c.name === "clickRefreshLink");
  assert.deepEqual(clicks.map((c) => c.target.tabId), h.createdTabs.map((t) => t.id));
  assert.deepEqual(clicks[0].args, [1200, 10000]);
});

test("refreshExpired reports progress to the popup before and after each photo", async () => {
  const h = setup();
  await runRefresh(h);

  const progress = h.sentMessages.filter((m) => m.type === "refreshProgress");
  assert.deepEqual(progress.map((m) => [m.uuid, m.status, m.done, m.total]), [
    [UUID_A, "opening", 0, 2],
    [UUID_A, "clicked", 1, 2],
    [UUID_B, "opening", 1, 2],
    [UUID_B, "clicked", 2, 2],
  ]);
  assert.ok(progress.every((m) => m.tabId === EMAIL_TAB));
});

test("refreshExpired logs each step to the service worker console", async () => {
  const h = setup();
  await runRefresh(h);

  assert.deepEqual(h.logs, [
    "[BH refresh] starting: 2 expired, 0 already requested",
    `[BH refresh] 1/2 ${UUID_A}: clicked`,
    `[BH refresh] 2/2 ${UUID_B}: clicked`,
    "[BH refresh] done: 2 requested, 0 available, 0 failed",
  ]);
});

test("getRefreshStatus lets a reopened popup see a run in progress and its outcome", async () => {
  const h = setup();
  assert.deepEqual(plain(await h.send({ type: "getRefreshStatus" })), { status: null });

  await h.send({ type: "refreshExpired", tabId: EMAIL_TAB });
  const during = plain(await h.send({ type: "getRefreshStatus" })).status;
  assert.equal(during.running, true);
  assert.equal(during.tabId, EMAIL_TAB);
  assert.equal(during.total, 2);

  await h.run("refreshTask");
  const after = plain(await h.send({ type: "getRefreshStatus" })).status;
  assert.equal(after.running, false);
  assert.equal(after.done, 2);
  assert.equal(after.requested, 2);
});

test("refreshExpired remembers requested photos so a second run sends no duplicate emails", async () => {
  const h = setup();
  await runRefresh(h);
  assert.deepEqual(h.sessionStore.refreshedUuids, [UUID_A, UUID_B]);

  const second = plain(await h.send({ type: "refreshExpired", tabId: EMAIL_TAB }));
  assert.deepEqual(second, { success: true, started: true, total: 0, alreadyRequested: 2 });
  await h.run("refreshTask");
  assert.equal(h.createdTabs.length, 2);
});

test("refreshExpired treats a page without a refresh link as available and does not remember it", async () => {
  const h = setup({ images: EMAIL_IMAGES.slice(0, 1), click: () => ({ status: "available" }) });
  const { done } = await runRefresh(h);

  assert.equal(done.requested, 0);
  assert.equal(done.available, 1);
  assert.deepEqual(h.removedTabs, [h.createdTabs[0].id]);
  assert.equal(h.sessionStore.refreshedUuids, undefined);
});

test("refreshExpired continues past a tab that fails to open", async () => {
  const h = setup({
    onTabCreate: (url) => {
      if (url === snapshot(UUID_A)) throw new Error("Tabs cannot be edited right now");
    },
  });
  const { done } = await runRefresh(h);

  assert.equal(done.requested, 1);
  assert.equal(done.failed, 1);
  assert.deepEqual(done.results[0], {
    uuid: UUID_A, url: snapshot(UUID_A), status: "failed", error: "Tabs cannot be edited right now",
  });
  assert.equal(done.results[1].status, "clicked");
});

test("refreshExpired fails a page that never loads and still closes its tab", async () => {
  const h = setup({ images: EMAIL_IMAGES.slice(0, 1), onTabCreate: () => ({ load: false }) });
  const { done } = await runRefresh(h);

  assert.equal(done.failed, 1);
  assert.equal(done.results[0].error, "Page did not load");
  assert.equal(h.executeScriptCalls.filter((c) => c.name === "clickRefreshLink").length, 0);
  assert.deepEqual(h.removedTabs, [h.createdTabs[0].id]);
});

test("refreshExpired counts a click as requested even if the follow-up page never finishes loading", async () => {
  const h = setup({ images: EMAIL_IMAGES.slice(0, 1), click: () => ({ status: "clicked" }) });
  const { done } = await runRefresh(h);

  assert.equal(done.requested, 1);
  assert.deepEqual(h.removedTabs, [h.createdTabs[0].id]);
});

test("refreshExpired fails a page whose injection returns nothing", async () => {
  const h = setup({ images: EMAIL_IMAGES.slice(0, 1), click: () => undefined });
  const { done } = await runRefresh(h);
  assert.equal(done.failed, 1);
  assert.equal(done.results[0].error, "No result from page");
});

test("refreshExpired leaves no tab listeners behind", async () => {
  const h = setup();
  await runRefresh(h);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.chrome.tabs.onUpdated.listeners.length, 0);
});

test("refreshExpired rejects a second run while one is in progress", async () => {
  const h = setup();
  const first = h.send({ type: "refreshExpired", tabId: EMAIL_TAB });
  const second = plain(await h.send({ type: "refreshExpired", tabId: EMAIL_TAB }));
  assert.deepEqual(second, { success: false, error: "A refresh is already running" });

  // Still locked after the first run has started but before it finishes.
  assert.equal(plain(await first).started, true);
  const third = plain(await h.send({ type: "refreshExpired", tabId: EMAIL_TAB }));
  assert.deepEqual(third, { success: false, error: "A refresh is already running" });

  // Released once the run finishes.
  await h.run("refreshTask");
  const fourth = plain(await h.send({ type: "refreshExpired", tabId: EMAIL_TAB }));
  assert.equal(fourth.success, true);
});

test("refreshExpired releases the lock when the email cannot be checked", async () => {
  let fail = true;
  const h = setup();
  h.chrome.scripting.executeScript = async () => {
    if (fail) throw new Error("Cannot access contents of the page");
    return [{ result: EMAIL_IMAGES }];
  };

  const res = plain(await h.send({ type: "refreshExpired", tabId: EMAIL_TAB }));
  assert.deepEqual(res, { success: false, error: "Cannot access contents of the page" });
  assert.deepEqual(plain(await h.send({ type: "getRefreshStatus" })), { status: null });

  fail = false;
  assert.equal(plain(await h.send({ type: "refreshExpired", tabId: EMAIL_TAB })).success, true);
  await h.run("refreshTask");
});

test("refreshExpired with nothing expired opens no tabs and still reports done", async () => {
  const h = setup({ images: EMAIL_IMAGES.slice(2) });
  const { started, done } = await runRefresh(h);
  assert.equal(started.total, 0);
  assert.equal(done.requested, 0);
  assert.equal(h.createdTabs.length, 0);
});
