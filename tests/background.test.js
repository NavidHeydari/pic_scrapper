const test = require("node:test");
const assert = require("node:assert/strict");
const { loadExtension, plain } = require("./helpers/harness");

const UUID_A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const UUID_B = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const BH = "https://mbdgw.brighthorizons.com/api/parent/medias/v1/media/m";
const snapshot = (uuid) => `${BH}/snapshot/${uuid}`;

const TAB = 3;

function mediaRequest(url, contentType) {
  return {
    url, tabId: TAB, statusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: contentType }],
  };
}

async function entriesFor(h, tabId = TAB) {
  return plain(await h.send({ type: "getEntries", tabId })).entries;
}

test("webRequest capture records media responses", async () => {
  const h = loadExtension();
  h.chrome.webRequest.onCompleted.emit(mediaRequest(snapshot(UUID_A), "image/jpeg"));

  const entries = await entriesFor(h);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, `snapshot_${UUID_A}.jpg`);
  assert.equal(entries[0].url, `${snapshot(UUID_A)}?d=t`);
});

test("webRequest capture skips expired media that serves an HTML page", async () => {
  const h = loadExtension();
  h.chrome.webRequest.onCompleted.emit(mediaRequest(snapshot(UUID_A), "text/html; charset=utf-8"));
  assert.deepEqual(await entriesFor(h), []);
});

test("scanTab skips and counts expired media instead of saving HTML as .jpg", async () => {
  const contentTypes = { [`${snapshot(UUID_A)}?d=t`]: "image/png", [`${snapshot(UUID_B)}?d=t`]: "text/html" };
  const h = loadExtension({
    scripts: {
      scanDomForUrls: () => ({ snapshotUrls: [snapshot(UUID_A), snapshot(UUID_B)], htmUrls: [] }),
    },
    fetch: async (url) => ({ headers: { get: () => contentTypes[url] } }),
  });

  const res = plain(await h.send({ type: "scanTab", tabId: TAB }));
  assert.equal(res.success, true);
  assert.equal(res.added, 1);
  assert.equal(res.expired, 1);
  assert.deepEqual((await entriesFor(h)).map((e) => e.name), [`snapshot_${UUID_A}.png`]);
});

test("scanTab probes an expired UUID only once when it appears in the DOM and an HTM page", async () => {
  const probes = [];
  const htmUrl = "https://mbdgw.brighthorizons.com/reports/daily.htm";
  const h = loadExtension({
    scripts: { scanDomForUrls: () => ({ snapshotUrls: [snapshot(UUID_B)], htmUrls: [htmUrl] }) },
    fetch: async (url, init) => {
      if (url === htmUrl) return { ok: true, text: async () => `<img src="${snapshot(UUID_B)}">` };
      probes.push([url, init?.method]);
      return { headers: { get: () => "text/html" } };
    },
  });

  const res = plain(await h.send({ type: "scanTab", tabId: TAB }));
  assert.equal(res.added, 0);
  assert.equal(res.expired, 1);
  assert.deepEqual(probes, [[`${snapshot(UUID_B)}?d=t`, "HEAD"]]);
});

test("scanTab keeps entries whose content type could not be probed", async () => {
  const h = loadExtension({
    scripts: { scanDomForUrls: () => ({ snapshotUrls: [snapshot(UUID_A)], htmUrls: [] }) },
    fetch: async () => { throw new Error("network down"); },
  });

  const res = plain(await h.send({ type: "scanTab", tabId: TAB }));
  assert.equal(res.added, 1);
  assert.equal(res.expired, 0);
  assert.equal((await entriesFor(h))[0].name, `snapshot_${UUID_A}.jpg`);
});
