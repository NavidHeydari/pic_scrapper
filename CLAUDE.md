# BH Picture Scraper — Claude Code Notes

## What This Is

A Chrome extension (Manifest V3) that captures and batch-downloads media (images and videos) from the Bright Horizons parent portal (`mbdgw.brighthorizons.com`). It passively intercepts media requests as the user browses, tracks them per tab, and lets the user download them all into a date-stamped folder. Supported media types include snapshots, observations, and any other media type served under the `/api/parent/medias/*/media/m/*` path.

## Architecture

| File | Role |
|---|---|
| `background.js` | Service worker — intercepts requests, manages per-tab state, drives downloads |
| `expired.js` | Expired-photo refresh — loaded into the service worker via `importScripts` |
| `tests/` | `node:test` suite; `tests/helpers/harness.js` runs the service worker in a `vm` with a mocked `chrome` |
| `popup.html/js/css` | Extension popup UI |
| `options.html/js` | Settings page (save directory name) |
| `manifest.json` | Chrome MV3 manifest |
| `generate_icons.py` | Generates `icons/icon{16,48,128}.png` (pure Python, no deps) |
| `diagram.mmd` | Architecture diagram (Mermaid) |

### Message flow (popup → background)

- `getEntries` → `{ entries }` — returns captured entries for the current tab
- `downloadAll` → `{ success, results }` — triggers batch download; accepts `tabId`, `parentDir`, `emailDate`
- `clearEntries` → `{ success }` — resets capture list for current tab
- `scanTab` → `{ success, added, total, htmFound, expired, failures }` — injects `scanDomForUrls` into the page to find media URLs, also fetches linked `.htm` pages to extract additional URLs; media whose HEAD probe returns `text/html` is counted as `expired` and not added
- `findExpired` → `{ success, total, unavailable, expired, alreadyRequested }` — reports expired BH media in the open email (no side effects)
- `refreshExpired` → `{ success, started, total, alreadyRequested }` — replies as soon as the run starts (never hold a message open for the whole run: Chrome kills the worker if one event exceeds 5 minutes). Progress is pushed as `refreshProgress` (`status: "opening" | "clicked" | "available" | "failed"`), the outcome as `refreshDone` `{ tabId, requested, available, failed, results, … }`
- `getRefreshStatus` → `{ status }` — current/last run summary (or `null`), so a reopened popup can show a run in progress
- The popup sends refresh messages through `sendToWorker()`, which turns an unreachable worker into `{ success: false, error }` instead of a rejected promise

### Expired-photo refresh (`expired.js`)

An expired BH media URL serves an HTML page with a "click here" link (`/media/m/refresh/<id>`); following it makes BH email a fresh copy.

1. `collectEmailImages` (injected into the email tab) waits for each `<img>` in Gmail's `div[role="main"] .a3s` bodies (or every image when not in Gmail) to load/fail, and reports `src` + natural size.
2. `classifyEmailImages` unwraps Gmail's proxy (`…googleusercontent.com/…#<original>`), keeps BH media that failed to load or shows Gmail's 200×200 placeholder, and de-dupes by UUID.
3. `refreshOne` opens each media page (without `?d=t`) in a background tab, injects `clickRefreshLink` (pause, scroll, hover, press, click), waits for the resulting navigation, then closes the tab. No refresh link → `available`.
4. Requested UUIDs are kept in `chrome.storage.session` (`refreshedUuids`) so repeat runs never send duplicate emails; only one run at a time.
5. While a run is active, `chrome.runtime.getPlatformInfo()` is pinged every 20 s to keep the worker past its 30 s idle timeout. Each step is logged as `[BH refresh] …` in the service worker console.

Pacing (`REFRESH_PACE`): 1.2–10 s before opening each page, 1.2–10 s on the page before clicking. Webrequest capture also ignores `text/html` responses so expired notices are never downloaded as `.jpg`.

### Scan flow (two-pass)

1. `scanDomForUrls` (injected into tab) scans the DOM HTML for two patterns:
   - `SCAN_URL_REGEX` — BH media API URLs (`/media/m/…`)
   - `HTM_URL_REGEX` — BH `.htm` page URLs
2. Direct media URLs are HEAD-probed to determine content-type/extension.
3. Each `.htm` URL is fetched server-side (from the service worker) via `fetchHtmAndExtractImages`, which extracts media URLs from the page HTML (both BH API URLs and direct `.jpg`/`.jpeg` URLs).
4. Newly found entries are de-duped by UUID, then appended to the tab's entry list.

### Download folder layout

```
Downloads/<parentDir>/<YYYY-MM-DD>/<type>_<uuid>.<ext>
```

- `<type>` — media type extracted from the URL (e.g. `snapshot`, `observations`)
- `<ext>` — file extension derived from the `Content-Type` response header (`.jpg`, `.png`, `.webp`, `.gif`, `.mp4`, `.webm`, `.mov`); falls back to `.jpg`
- The date is extracted from the tab DOM (three strategies: `<time datetime>`, "Month DD, YYYY" text, MM/DD/YYYY numeric). Falls back to today's date.

### State management

- `tabEntries` (`Map<string, Entry[]>`) — in-memory, keyed by `"tab_<tabId>"`; each entry has `{ uuid, url, name, timestamp }`
- `chrome.storage.session` — persists entries across service worker restarts
- `chrome.storage.sync` — persists `parentDir` setting

### Human-like download pacing (`PACE` constants)

Downloads are shuffled (Fisher-Yates) and spaced with random delays to avoid request bursts:

| Constant | Range | Purpose |
|---|---|---|
| `THINK_MIN/MAX` | 1.5–4 s | Pause before first download |
| `IMAGE_MIN/MAX` | 2–7 s | Gap between image downloads |
| `VIDEO_MIN/MAX` | 10–25 s | Longer gap after video entries |
| `DISTRACTION_MIN/MAX` | 20–60 s | Occasional long pause (12% probability) |

HEAD probes during scan are also staggered (300–1200 ms each).

## Key Constraints

- Host permissions are narrowly scoped to `https://mbdgw.brighthorizons.com/*`
- `URL_PATTERN` (webRequest filter) uses `…/media/m/*` to catch all media types broadly
- `toDownloadUrl()` validates the URL strictly (versioned API path `v[0-9]`, RFC 4122 v1–v5 UUID) and returns `{ uuid, url, prefix }` — `prefix` is the sanitized media type used as the filename prefix
- `SCAN_URL_REGEX` matches any media type segment under `/media/m/` during DOM scanning
- `HTM_URL_REGEX` matches `.htm` page URLs on the BH domain during DOM scanning
- UUIDs are strictly validated against RFC 4122 v1–v5 format in `toDownloadUrl()`
- `sanitizePath()` (background) and `sanitizeDir()` (popup/options) both prevent path traversal and illegal filename characters; fall back to `"BrightHorizons"` if empty
- Extension uses `scripting` + `activeTab` to inject scripts for DOM scanning and date extraction
- Badge on the extension icon shows the live count of captured items for the active tab

## Development Notes

- No build step — load unpacked directly from this folder via `chrome://extensions`
- Tests: `npm test` (`node --test`, no dependencies). Without a Node install, VS Code's runtime works: `ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" --test`
- Functions passed to `chrome.scripting.executeScript` are serialized — they must not reference anything outside themselves
- Icons are generated by `generate_icons.py` (pure Python, no deps)
- Architecture diagram is in `diagram.mmd` (Mermaid)
