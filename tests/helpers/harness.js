// Loads the service worker (background.js + importScripts'd files) into an isolated vm context
// with a mocked `chrome` API, so its message handlers can be exercised from node:test.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    emit: (...args) => listeners.slice().map((fn) => fn(...args)),
  };
}

// Values crossing the vm boundary have the context's prototypes; normalise for deepStrictEqual.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Let pending microtasks and setTimeout callbacks (mapped to setImmediate) run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {object}   [opts]
 * @param {object}   [opts.session]      initial chrome.storage.session contents
 * @param {function} [opts.fetch]        fetch(url, init) mock
 * @param {object}   [opts.scripts]      { [injectedFunctionName]: (injectOpts, h) => result }
 * @param {function} [opts.onTabCreate]  (url, h) => { load?: boolean } | throws
 */
function loadExtension({ session = {}, fetch, scripts = {}, onTabCreate } = {}) {
  const sessionStore = { ...session };
  const sentMessages = [];
  const tabs = new Map();
  const createdTabs = [];
  const removedTabs = [];
  let nextTabId = 100;
  let nextIntervalId = 1;

  const tabsOnUpdated = createEvent();

  const h = {
    sentMessages,
    sessionStore,
    tabs,
    createdTabs,
    removedTabs,
    executeScriptCalls: [],
    platformInfoCalls: 0,
    // Active setInterval callbacks, by id; tick() runs them all once.
    intervals: new Map(),
    tick() { for (const fn of h.intervals.values()) fn(); },
    logs: [],
    // Simulate the tab navigating to a new page (loading → complete).
    navigate(tabId) {
      queueMicrotask(() => {
        tabs.get(tabId).status = "loading";
        tabsOnUpdated.emit(tabId, { status: "loading" });
        tabs.get(tabId).status = "complete";
        tabsOnUpdated.emit(tabId, { status: "complete" });
      });
    },
  };

  const chrome = {
    storage: {
      session: {
        async get(keys) {
          if (keys === null || keys === undefined) return { ...sessionStore };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in sessionStore) out[k] = sessionStore[k];
          return out;
        },
        async set(items) { Object.assign(sessionStore, plain(items)); },
        async remove(key) { delete sessionStore[key]; },
      },
      sync: {
        async get(defaults) { return { ...defaults }; },
        async set() {},
      },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    downloads: {
      onChanged: createEvent(),
      download(_opts, cb) { cb(1); },
      cancel() {},
    },
    webRequest: { onCompleted: createEvent() },
    tabs: {
      onRemoved: createEvent(),
      onActivated: createEvent(),
      onUpdated: tabsOnUpdated,
      async create({ url, active }) {
        const behaviour = onTabCreate ? onTabCreate(url, h) || {} : {};
        const tab = { id: nextTabId++, url, active, status: "loading" };
        tabs.set(tab.id, tab);
        createdTabs.push({ id: tab.id, url, active });
        if (behaviour.load !== false) {
          queueMicrotask(() => {
            tab.status = "complete";
            tabsOnUpdated.emit(tab.id, { status: "complete" });
          });
        }
        return tab;
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return tabs.get(id);
      },
      async remove(id) {
        removedTabs.push(id);
        tabs.delete(id);
      },
    },
    runtime: {
      onMessage: createEvent(),
      async sendMessage(message) { sentMessages.push(plain(message)); },
      async getPlatformInfo() { h.platformInfoCalls++; return { os: "win" }; },
    },
    scripting: {
      async executeScript(injectOpts) {
        const name = injectOpts.func.name;
        h.executeScriptCalls.push({ name, target: plain(injectOpts.target), args: plain(injectOpts.args || []) });
        const handler = scripts[name];
        if (!handler) throw new Error(`Unexpected injection: ${name}`);
        return [{ result: await handler(injectOpts, h) }];
      },
    },
  };

  const context = vm.createContext({
    chrome,
    fetch: fetch || (async () => { throw new Error("fetch not mocked"); }),
    // Capture logs instead of printing them in test output.
    console: { ...console, log: (...args) => h.logs.push(args.join(" ")) },
    // Timers fire on the next macrotask so pacing delays don't slow tests down.
    setTimeout: (fn) => setImmediate(fn),
    clearTimeout: (handle) => clearImmediate(handle),
    // Intervals never fire on their own; tests drive them with h.tick().
    setInterval: (fn) => {
      const id = nextIntervalId++;
      h.intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => h.intervals.delete(id),
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context, { filename: "background.js" });

  h.context = context;
  h.chrome = chrome;
  // Evaluate an expression inside the service worker scope (reaches top-level const/let too).
  h.run = (code) => vm.runInContext(code, context);
  // Deliver a runtime message the way the popup does, resolving with the handler's response.
  h.send = (message) => new Promise((resolve) => {
    for (const listener of chrome.runtime.onMessage.listeners) listener(message, {}, resolve);
  });
  return h;
}

module.exports = { loadExtension, plain, flush };
