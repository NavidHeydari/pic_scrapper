# BH Picture Scraper

A Chrome extension (Manifest V3) that automatically captures and batch-downloads snapshot images from the Bright Horizons parent portal.

## How It Works

1. The extension monitors network requests to the BH snapshot API using `chrome.webRequest`.
2. When you browse photo pages on the Bright Horizons portal, captured images are tracked per tab and shown as a badge count on the extension icon.
3. Open the popup to see captured filenames, then click **Download All** to save them in one go.

## Features

- **Automatic capture** — images are detected as you browse, no manual action needed.
- **Per-tab tracking** — each tab maintains its own capture list.
- **Batch download** — downloads all captured images to `Downloads/<folder>/<YYYY-MM-DD>/`.
- **Configurable save folder** — set a custom parent directory from the popup or options page.
- **Retry on failure** — failed downloads are kept so you can retry without losing progress.
- **Path sanitization** — directory input is validated to prevent path traversal and illegal characters.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.
5. Navigate to the [Bright Horizons parent portal](https://mybrighthorizons.com) and browse photo pages.

## Usage

1. Browse your child's photo pages on the BH portal — the badge count increments as images load.
2. Click the extension icon to open the popup.
3. (Optional) Set a custom save folder name.
4. Click **Download All** — images are saved to `Downloads/<folder>/<date>/`.
5. Use **Clear** to reset the capture list for the current tab.

## Project Structure

```
background.js    — Service worker: intercepts requests, manages state, handles downloads
popup.html/js/css — Extension popup UI
options.html/js  — Settings page for configuring the save directory
manifest.json    — Chrome extension manifest (MV3)
icons/           — Extension icons (16, 48, 128px)
```

## Permissions

| Permission | Reason |
|---|---|
| `webRequest` | Intercept BH snapshot image requests |
| `downloads` | Save images to the downloads folder |
| `storage` | Persist settings and capture state across service worker restarts |
| `host_permissions` | Scoped to `https://mbdgw.brighthorizons.com/*` only |
