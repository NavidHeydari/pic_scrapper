const test = require("node:test");
const assert = require("node:assert/strict");
const { loadExtension, plain } = require("./helpers/harness");

const UUID_A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const UUID_B = "a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d";
const BH = "https://mbdgw.brighthorizons.com/api/parent/medias/v1/media/m";
const snapshot = (uuid) => `${BH}/snapshot/${uuid}`;
const observation = (uuid) => `${BH}/observations/${uuid}`;
const gmailProxy = (url) => `https://ci3.googleusercontent.com/meips/ADKq_Nb3x=s0-d-e1-ft#${url}`;

// --- Pure helpers ---

test("extractOriginalUrl returns the original URL from a Gmail proxied src", () => {
  const h = loadExtension();
  assert.equal(h.context.extractOriginalUrl(gmailProxy(snapshot(UUID_A))), snapshot(UUID_A));
});

test("extractOriginalUrl decodes a percent-encoded original URL", () => {
  const h = loadExtension();
  const encoded = gmailProxy(encodeURIComponent(snapshot(UUID_A)));
  assert.equal(h.context.extractOriginalUrl(encoded), snapshot(UUID_A));
});

test("extractOriginalUrl keeps a malformed escape instead of throwing", () => {
  const h = loadExtension();
  const src = gmailProxy(`${snapshot(UUID_A)}%E0%A4%A`);
  assert.equal(h.context.extractOriginalUrl(src), `${snapshot(UUID_A)}%E0%A4%A`);
});

test("extractOriginalUrl leaves non-proxied and non-URL fragments unchanged", () => {
  const h = loadExtension();
  const { extractOriginalUrl } = h.context;
  assert.equal(extractOriginalUrl(snapshot(UUID_A)), snapshot(UUID_A));
  assert.equal(extractOriginalUrl("https://example.com/a.png#section"), "https://example.com/a.png#section");
  assert.equal(extractOriginalUrl(undefined), "");
});

test("isUnavailableImage flags failed loads and the 200x200 placeholder for BH media only", () => {
  const h = loadExtension();
  const { isUnavailableImage } = h.context;
  assert.equal(isUnavailableImage({ naturalWidth: 0, naturalHeight: 0 }, false), true);
  assert.equal(isUnavailableImage({ naturalWidth: 200, naturalHeight: 200 }, true), true);
  assert.equal(isUnavailableImage({ naturalWidth: 200, naturalHeight: 200 }, false), false);
  assert.equal(isUnavailableImage({ naturalWidth: 640, naturalHeight: 480 }, true), false);
  assert.equal(isUnavailableImage({ naturalWidth: 200, naturalHeight: 150 }, true), false);
});

test("isExpiredContentType matches HTML responses only", () => {
  const h = loadExtension();
  const { isExpiredContentType } = h.context;
  assert.equal(isExpiredContentType("text/html"), true);
  assert.equal(isExpiredContentType("Text/HTML; charset=utf-8"), true);
  assert.equal(isExpiredContentType("image/jpeg"), false);
  assert.equal(isExpiredContentType("video/mp4"), false);
  assert.equal(isExpiredContentType(null), false);
});

test("classifyEmailImages returns expired BH media, de-duped, with ?d=t-free page URLs", () => {
  const h = loadExtension();
  const result = plain(h.context.classifyEmailImages([
    { src: gmailProxy(snapshot(UUID_A)), naturalWidth: 200, naturalHeight: 200 },          // placeholder
    { src: gmailProxy(snapshot(UUID_A.toUpperCase())), naturalWidth: 0, naturalHeight: 0 }, // duplicate
    { src: gmailProxy(observation(UUID_B)), naturalWidth: 0, naturalHeight: 0 },            // other type
    { src: gmailProxy(snapshot("not-a-uuid")), naturalWidth: 0, naturalHeight: 0 },         // invalid
    { src: "https://example.com/tracker.gif", naturalWidth: 0, naturalHeight: 0 },          // not BH
    { src: "https://example.com/logo.png", naturalWidth: 200, naturalHeight: 200 },         // fine
    { src: gmailProxy(snapshot("0d9c8b7a-6f5e-4d3c-8b2a-190807060504")), naturalWidth: 800, naturalHeight: 600 },
  ]));

  assert.equal(result.total, 7);
  assert.equal(result.unavailable, 5);
  assert.deepEqual(result.expired, [
    { uuid: UUID_A, prefix: "snapshot", pageUrl: snapshot(UUID_A) },
    { uuid: UUID_B, prefix: "observations", pageUrl: observation(UUID_B) },
  ]);
});

test("classifyEmailImages handles an empty or missing list", () => {
  const h = loadExtension();
  assert.deepEqual(plain(h.context.classifyEmailImages([])), { total: 0, unavailable: 0, expired: [] });
  assert.deepEqual(plain(h.context.classifyEmailImages(undefined)), { total: 0, unavailable: 0, expired: [] });
});

// --- Injected: collectEmailImages ---

function fakeImg({ src, width = 0, height = 0, complete = true }) {
  const listeners = {};
  return {
    src, naturalWidth: width, naturalHeight: height, complete,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, w, h) {
      this.naturalWidth = w;
      this.naturalHeight = h;
      (listeners[type] || []).forEach((fn) => fn());
    },
  };
}

function fakeDocument({ bodies = [], images = [], links = [] } = {}) {
  return {
    querySelectorAll(selector) {
      if (selector === 'div[role="main"] .a3s') return bodies.map((imgs) => ({ querySelectorAll: () => imgs }));
      if (selector === "img") return images;
      if (selector === "a") return links;
      return [];
    },
  };
}

test("collectEmailImages reads images from Gmail message bodies only", async () => {
  const h = loadExtension();
  const inEmail = fakeImg({ src: gmailProxy(snapshot(UUID_A)), width: 640, height: 480 });
  const outsideEmail = fakeImg({ src: "https://mail.google.com/avatar.png", width: 32, height: 32 });
  h.context.document = fakeDocument({ bodies: [[inEmail]], images: [inEmail, outsideEmail] });

  const result = plain(await h.context.collectEmailImages(8000));
  assert.deepEqual(result, [{ src: gmailProxy(snapshot(UUID_A)), naturalWidth: 640, naturalHeight: 480 }]);
});

test("collectEmailImages falls back to every image when not in Gmail", async () => {
  const h = loadExtension();
  const a = fakeImg({ src: snapshot(UUID_A), width: 0 });
  const b = fakeImg({ src: snapshot(UUID_B), width: 300, height: 200 });
  h.context.document = fakeDocument({ images: [a, b] });

  const result = plain(await h.context.collectEmailImages(8000));
  assert.deepEqual(result.map((r) => r.src), [snapshot(UUID_A), snapshot(UUID_B)]);
});

test("collectEmailImages waits for images still loading", async () => {
  const h = loadExtension();
  const loading = fakeImg({ src: snapshot(UUID_A), complete: false });
  const failing = fakeImg({ src: snapshot(UUID_B), complete: false });
  h.context.document = fakeDocument({ bodies: [[loading, failing]] });

  const pending = h.context.collectEmailImages(8000);
  loading.fire("load", 1024, 768);
  failing.fire("error", 0, 0);

  const result = plain(await pending);
  assert.deepEqual(result.map((r) => r.naturalWidth), [1024, 0]);
});

test("collectEmailImages gives up on an image that never settles", async () => {
  const h = loadExtension();
  const stuck = fakeImg({ src: snapshot(UUID_A), complete: false });
  h.context.document = fakeDocument({ bodies: [[stuck]] });

  const result = plain(await h.context.collectEmailImages(8000));
  assert.deepEqual(result, [{ src: snapshot(UUID_A), naturalWidth: 0, naturalHeight: 0 }]);
});

// --- Injected: clickRefreshLink ---

function fakeLink(href) {
  return {
    href,
    events: [],
    clicks: 0,
    scrolled: false,
    scrollIntoView() { this.scrolled = true; },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 20 }),
    dispatchEvent(event) { this.events.push(event.type); },
    click() { this.clicks++; },
  };
}

function installPageGlobals(h, links) {
  h.context.document = fakeDocument({ links });
  h.context.window = {};
  h.context.MouseEvent = class { constructor(type, init) { this.type = type; this.init = init; } };
}

test("clickRefreshLink clicks the refresh link with a human-like event sequence", async () => {
  const h = loadExtension();
  const other = fakeLink("https://mbdgw.brighthorizons.com/help");
  const refresh = fakeLink(`${BH}/refresh/${UUID_A}`);
  installPageGlobals(h, [other, refresh]);

  const result = plain(await h.context.clickRefreshLink(0, 0));

  assert.deepEqual(result, { status: "clicked" });
  assert.equal(refresh.scrolled, true);
  assert.deepEqual(refresh.events, ["mouseover", "mouseenter", "mousemove", "mousedown", "mouseup"]);
  assert.equal(refresh.clicks, 1);
  assert.equal(other.clicks, 0);
});

test("clickRefreshLink reports an available photo when there is no refresh link", async () => {
  const h = loadExtension();
  const other = fakeLink("https://mbdgw.brighthorizons.com/help");
  installPageGlobals(h, [other]);

  assert.deepEqual(plain(await h.context.clickRefreshLink(0, 0)), { status: "available" });
  assert.equal(other.clicks, 0);
});
