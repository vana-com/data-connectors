# Data Connectors

Playwright-based data connectors for [DataConnect](https://github.com/vana-com/data-connect). Each connector exports a user's data from a web platform using browser automation — credentials never leave the device.

## Connectors

| Platform | Company | Runtime | Scopes |
|----------|---------|---------|--------|
| ChatGPT | OpenAI | playwright | chatgpt.conversations, chatgpt.memories |
| GitHub | GitHub | playwright | github.profile, github.repositories, github.starred |
| Instagram | Meta | playwright | instagram.profile, instagram.posts |
| LinkedIn | LinkedIn | playwright | linkedin.profile, .experience, .education, .skills, .languages |
| Spotify | Spotify | playwright | spotify.profile, spotify.savedTracks, spotify.playlists |
| YouTube | Google | playwright | youtube.profile, youtube.subscriptions, youtube.playlists, youtube.playlistItems, youtube.likes, youtube.watchLater, youtube.history (top 50 recent items) |

## Repository structure

```
connectors/
├── registry.json                  # Central registry (checksums, versions)
├── test-connector.cjs             # Standalone test runner (see Testing locally)
├── types/
│   └── connector.d.ts             # TypeScript type definitions
├── schemas/                       # JSON schemas for exported data
│   ├── chatgpt.conversations.json
│   └── ...
├── openai/
│   ├── chatgpt-playwright.js      # Connector script
│   └── chatgpt-playwright.json    # Metadata
├── github/
│   ├── github-playwright.js
│   └── github-playwright.json
├── linkedin/
│   ├── linkedin-playwright.js
│   └── linkedin-playwright.json
├── meta/
│   ├── instagram-playwright.js
│   └── instagram-playwright.json
├── spotify/
│   ├── spotify-playwright.js
│   └── spotify-playwright.json
└── google/
    ├── youtube-playwright.js      # Connector script
    └── youtube-playwright.json    # Metadata
```

Each connector consists of two files inside a `<company>/` directory:

- **`<name>-playwright.js`** — the connector script (plain JS, runs inside the Playwright runner sidecar)
- **`<name>-playwright.json`** — metadata (display name, login URL, selectors, scopes)

---

## How connectors work

Connectors run in a sandboxed Playwright browser managed by the DataConnect app. The runner provides a `page` API object (not raw Playwright). The browser starts **headless**; connectors call `page.showBrowser()` when login is needed and `page.goHeadless()` after.

### Two-phase architecture

**Phase 1 — Login (visible browser)**
1. Navigate to the platform's login page (headless)
2. Check if the user is already logged in via persistent session
3. If not, show the browser so the user can log in manually
4. Extract auth tokens/cookies once logged in

**Phase 2 — Data collection (headless)**
1. Switch to headless mode (browser disappears)
2. Fetch data via API calls, network capture, or DOM scraping
3. Report structured progress to the UI
4. Return the collected data with an export summary

### Scoped result format

Connectors return a **scoped result object** where data keys use the format `source.category` (e.g., `linkedin.profile`, `chatgpt.conversations`). The frontend auto-detects these scoped keys (any key containing a `.` that isn't a metadata field) and POSTs each scope separately to the Personal Server at `POST /v1/data/{scope}`.

```javascript
const result = {
  'platform.scope1': { /* scope data */ },
  'platform.scope2': { /* scope data */ },
  exportSummary: { count, label, details },
  timestamp: new Date().toISOString(),
  version: '2.0.0-playwright',
  platform: 'platform-name',
};
```

Metadata keys (`exportSummary`, `timestamp`, `version`, `platform`) are not treated as scopes.

### Data extraction patterns

| Pattern | When to use | Example connector |
|---------|------------|-------------------|
| **API fetch** via `page.evaluate()` | Platform has REST/JSON APIs | `openai/chatgpt-playwright.js` |
| **Network capture** via `page.captureNetwork()` | Platform uses GraphQL/XHR that fires on navigation | `meta/instagram-playwright.js` |
| **DOM scraping** via `page.evaluate()` | No API available, data only in rendered HTML | `linkedin/linkedin-playwright.js` |

---

## Building a new connector

### 1. Create the metadata file

Create `connectors/<company>/<name>-playwright.json`:

```json
{
  "id": "<name>-playwright",
  "version": "1.0.0",
  "name": "Platform Name",
  "company": "Company",
  "description": "Exports your ... using Playwright browser automation.",
  "connectURL": "https://platform.com/login",
  "connectSelector": "css-selector-for-logged-in-state",
  "exportFrequency": "daily",
  "runtime": "playwright",
  "vectorize_config": { "documents": "field_name" }
}
```

- `runtime` must be `"playwright"`
- `connectURL` is where the browser navigates initially
- `connectSelector` detects whether the user is logged in (e.g. an element only visible post-login)

### 2. Create the connector script

Create `connectors/<company>/<name>-playwright.js`:

```javascript
// State management
const state = { isComplete: false };

// ─── Login check ──────────────────────────────────────
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const hasLoggedInEl = !!document.querySelector('LOGGED_IN_SELECTOR');
        const hasLoginForm = !!document.querySelector('LOGIN_FORM_SELECTOR');
        return hasLoggedInEl && !hasLoginForm;
      })()
    `);
  } catch { return false; }
};

// ─── Main flow ────────────────────────────────────────
(async () => {
  // Phase 1: Login
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  if (!(await checkLoginStatus())) {
    await page.showBrowser('https://platform.com/login');
    await page.setData('status', 'Please log in...');
    await page.promptUser(
      'Please log in. Click "Done" when ready.',
      async () => await checkLoginStatus(),
      2000
    );
  }

  // Phase 2: Headless data collection
  await page.goHeadless();

  await page.setProgress({
    phase: { step: 1, total: 2, label: 'Fetching profile' },
    message: 'Loading profile data...',
  });

  // ... fetch your data here ...
  const items = [];

  // Build result using scoped keys (exportSummary is required)
  const result = {
    'platform.items': {
      items: items,
      total: items.length,
    },
    exportSummary: {
      count: items.length,
      label: items.length === 1 ? 'item' : 'items',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'platform-name',
  };

  state.isComplete = true;
  await page.setData('result', result);
})();
```

### 3. Add a data schema (optional)

Create `connectors/schemas/<platform>.<scope>.json` to describe the exported data format:

```json
{
  "name": "Platform Items",
  "version": "1.0.0",
  "scope": "platform.items",
  "dialect": "json",
  "description": "Description of the exported data",
  "schema": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "properties": {
            "id": { "type": "string" },
            "title": { "type": "string" }
          },
          "required": ["id", "title"]
        }
      }
    },
    "required": ["items"]
  }
}
```

### 4. Update the registry

Add your connector to `registry.json`. Generate checksums with:

```bash
shasum -a 256 <company>/<name>-playwright.js | awk '{print "sha256:" $1}'
shasum -a 256 <company>/<name>-playwright.json | awk '{print "sha256:" $1}'
```

Then add an entry to the `connectors` array:

```json
{
  "id": "<name>-playwright",
  "company": "<company>",
  "version": "1.0.0",
  "name": "Platform Name",
  "description": "...",
  "files": {
    "script": "<company>/<name>-playwright.js",
    "metadata": "<company>/<name>-playwright.json"
  },
  "checksums": {
    "script": "sha256:<hash>",
    "metadata": "sha256:<hash>"
  }
}
```

---

## Page API reference

The `page` object is available as a global in connector scripts:

| Method | Description |
|--------|-------------|
| `page.evaluate(jsString)` | Run JS in browser context, return result |
| `page.goto(url)` | Navigate to URL |
| `page.sleep(ms)` | Wait for milliseconds |
| `page.setData(key, value)` | Send data to host (`'status'`, `'error'`, `'result'`) |
| `page.setProgress({phase, message, count})` | Structured progress for the UI |
| `page.showBrowser(url?)` | Switch to headed mode (visible browser) |
| `page.goHeadless()` | Switch to headless mode (invisible) |
| `page.promptUser(msg, checkFn, interval)` | Show prompt, poll `checkFn` until truthy |
| `page.captureNetwork({urlPattern, bodyPattern, key})` | Register a network capture |
| `page.getCapturedResponse(key)` | Get captured response or `null` |
| `page.clearNetworkCaptures()` | Clear all captures |
| `page.closeBrowser()` | Close browser, keep process for HTTP work |

### Progress reporting

```javascript
await page.setProgress({
  phase: { step: 1, total: 3, label: 'Fetching memories' },
  message: 'Downloaded 50 of 200 items...',
  count: 50,
});
```

- `phase.step` / `phase.total` — drives the step indicator ("Step 1 of 3")
- `phase.label` — short label for the current phase
- `message` — human-readable progress text
- `count` — numeric count for progress tracking

---

## Testing locally

### Prerequisites

- [DataConnect](https://github.com/vana-com/data-connect) cloned and able to run (`npm run tauri:dev`)

### Setup

1. Clone this repo alongside DataConnect:

```bash
git clone https://github.com/vana-com/data-connectors.git
```

2. Point DataConnect to your local connectors during development:

```bash
# From the DataConnect repo
CONNECTORS_PATH=../data-connectors npm run tauri:dev
```

The `CONNECTORS_PATH` environment variable tells the fetch script to skip downloading and use your local directory instead.

3. After editing connector files, sync them to the app's runtime directory:

```bash
# From the DataConnect repo
node scripts/sync-connectors-dev.js
```

This copies your connector files to `~/.dataconnect/connectors/` where the running app reads them. The app checks this directory first, so your local edits take effect without rebuilding.

### Iteration loop

1. Edit your connector script
2. Run `node scripts/sync-connectors-dev.js` (from the DataConnect repo)
3. Click the connector in the app to test
4. Check logs in `~/Library/Logs/DataConnect/` (macOS) for debugging

### Standalone test runner

You can test connectors directly without starting the full DataConnect app using the included test runner. It spawns the playwright-runner as a child process and pretty-prints the JSON protocol messages.

**Prerequisites:** The [DataConnect](https://github.com/vana-com/data-connect) repo cloned alongside this one (the runner auto-detects `../data-dt-app/playwright-runner`), or set `PLAYWRIGHT_RUNNER_DIR` to point to the playwright-runner directory.

```bash
# Run a connector in headed mode (browser visible — default)
node test-connector.cjs ./linkedin/linkedin-playwright.js

# Run headless (no visible browser)
node test-connector.cjs ./linkedin/linkedin-playwright.js --headless

# Override the initial URL
node test-connector.cjs ./linkedin/linkedin-playwright.js --url https://linkedin.com/feed

# Save result to a custom path (default: ./connector-result.json)
node test-connector.cjs ./linkedin/linkedin-playwright.js --output ./my-result.json
```

The runner reads the connector's sibling `.json` metadata to automatically resolve the `connectURL`. In headed mode, the browser stays visible throughout the run (the `goHeadless()` call becomes a no-op), making it easy to observe what the connector is doing.

---

## Contributing

### Adding a new connector

1. Fork this repo
2. Create a branch: `git checkout -b feat/<platform>-connector`
3. Add your files in `connectors/<company>/`:
   - `<name>-playwright.js` — connector script
   - `<name>-playwright.json` — metadata
   - `schemas/<platform>.<scope>.json` — data schema (optional but encouraged)
4. Test locally using the instructions above
5. Update `registry.json` with your connector entry and checksums
6. Open a pull request

### Modifying an existing connector

1. Fork and branch
2. Make your changes to the connector script and/or metadata
3. Test locally
4. Update the version in the metadata JSON
5. Regenerate checksums and update `registry.json`
6. Open a pull request

### Guidelines

- **Credentials stay on-device.** Connectors run in a local browser. Never send tokens or passwords to external servers.
- **Use `page.setProgress()`** to report progress. Users should see what's happening during long exports.
- **Include `exportSummary`** in the result. The UI uses it to display what was collected.
- **Handle errors gracefully.** Use `page.setData('error', message)` and provide clear error messages.
- **Prefer API fetch over DOM scraping** when the platform has usable APIs. APIs are more stable than DOM structure.
- **Avoid relying on CSS class names** — many platforms obfuscate them. Use structural selectors, heading text, and content heuristics instead.
- **Rate-limit API calls.** Add `page.sleep()` between requests to avoid triggering rate limits.
- **Test pagination edge cases** — empty results, single page, large datasets.

### Registry checksums

The registry uses SHA-256 checksums to verify file integrity during OTA updates. Always regenerate checksums when modifying connector files:

```bash
shasum -a 256 <company>/<name>-playwright.js | awk '{print "sha256:" $1}'
shasum -a 256 <company>/<name>-playwright.json | awk '{print "sha256:" $1}'
```

---

## How the registry works

DataConnect fetches `registry.json` from this repo on app startup and during `npm postinstall`. For each connector listed:

1. Check if local files exist with matching checksums
2. If not, download from `baseUrl/<file_path>` (this repo's raw GitHub URL)
3. Verify SHA-256 checksums match
4. Write to local `connectors/` directory

This enables OTA connector updates without requiring a full app release.
