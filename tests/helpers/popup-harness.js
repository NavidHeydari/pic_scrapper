// Loads popup.js into a vm context with a minimal fake DOM and a mocked `chrome` API.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

function fakeElement(id) {
  const classes = new Set();
  const listeners = {};
  const children = [];
  return {
    id,
    value: "",
    textContent: "",
    disabled: false,
    style: {},
    dataset: {},
    children,
    get className() { return [...classes].join(" "); },
    set className(v) { classes.clear(); v.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    set innerHTML(_v) { children.length = 0; },
    appendChild(child) { children.push(child); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    // Run every listener for the event and wait for their async work.
    async dispatch(type) { await Promise.all((listeners[type] || []).map((fn) => fn())); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {function} respond  (message) => response | Promise; throw/reject to simulate a dead worker
 */
async function loadPopup(respond) {
  const elements = new Map();
  const messageListeners = [];
  const sent = [];

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
    createElement: () => fakeElement(null),
  };

  const chrome = {
    storage: { sync: { get: async (d) => ({ ...d }), set: async () => {} } },
    tabs: { query: async () => [{ id: 7 }] },
    scripting: { executeScript: async () => [{ result: null }] },
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      async sendMessage(message) {
        sent.push(message);
        if (message.type === "getEntries") return { entries: [] };
        if (message.type === "getDownloadStatus") return { status: {} };
        return respond(message);
      },
    },
  };

  const context = vm.createContext({ document, chrome, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"), context, { filename: "popup.js" });
  await flush();

  return {
    el: (id) => elements.get(id),
    sent,
    click: (id) => elements.get(id).dispatch("click"),
    // Deliver a message pushed from the service worker.
    push: (message) => messageListeners.forEach((fn) => fn(message)),
  };
}

module.exports = { loadPopup };
