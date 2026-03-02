---
name: data-connector
description: >
  Build new Vana DataConnect data connectors that export user data from web platforms.
  Use when asked to "create a connector", "add a connector", "build a connector",
  "new data connector", "write a connector for X", or when working on the data-connectors
  repository and the task involves adding or modifying a Playwright-based connector.
---

# Data Connector Builder

Build Playwright-based data connectors for the Vana DataConnect ecosystem. Connectors export
a user's personal data from web platforms (LinkedIn, ChatGPT, Spotify, etc.) using browser
automation. Credentials never leave the device.

## Repository Layout

```
/Users/volod/vana/data-connectors/
├── registry.json                    # Central manifest with checksums
├── test-connector.cjs               # Standalone test runner
├── types/connector.d.ts             # TypeScript type definitions
├── schemas/                         # JSON Schema files (one per scope)
│   └── <platform>.<scope>.json
├── icons/                           # SVG icons for UI
└── <company>/                       # One folder per company
    ├── <name>-playwright.js         # Connector script
    └── <name>-playwright.json       # Metadata
```

## Workflow

### Step 1 — Research the target platform

Before writing code, investigate the platform:

1. **Check for REST/JSON APIs** accessible from a logged-in browser session. Open DevTools Network tab, browse the platform, look for XHR/fetch calls returning JSON. This is the preferred extraction method.
2. **Check for GraphQL endpoints** — many modern platforms use these.
3. **If no API**, plan DOM scraping as a fallback. Identify stable selectors (ARIA roles, data attributes, semantic HTML). Never rely on obfuscated CSS class names.
4. **Identify the login flow** — what URL, what selectors prove the user is logged in, are there challenges/2FA/captchas to handle.
5. **Define scopes** — what data categories to export (e.g., `platform.profile`, `platform.posts`).

### Step 2 — Create the metadata file

Create `<company>/<name>-playwright.json`. See [templates/connector-metadata.json](templates/connector-metadata.json).

Required fields: `id`, `version`, `name`, `company`, `description`, `connectURL`, `connectSelector`, `runtime` (always `"playwright"`).

The `connectSelector` is critical — it's how DataConnect detects the user is logged in. Pick a CSS selector only visible post-login (e.g., a feed element, profile avatar, nav item).

### Step 3 — Write the connector script

Create `<company>/<name>-playwright.js`. See [templates/connector-script.js](templates/connector-script.js).

All connectors follow the **two-phase pattern**:

**Phase 1 — Login (visible browser)**
1. Check if already logged in via persistent session
2. If not, call `page.showBrowser(loginUrl)` so the user can log in manually
3. Call `page.promptUser()` to wait until login is complete

**Phase 2 — Data collection (headless)**
1. Call `page.goHeadless()` — browser disappears
2. Fetch data via API calls, network capture, or DOM scraping
3. Report progress via `page.setProgress()`
4. Build scoped result object and call `page.setData('result', result)`

For the full `page` API reference, see [PAGE-API.md](PAGE-API.md).
For extraction pattern examples, see [PATTERNS.md](PATTERNS.md).

### Step 4 — Create JSON schemas

Create `schemas/<platform>.<scope>.json` for each scope. See [templates/schema.json](templates/schema.json).

### Step 5 — Update the registry

Generate checksums and add entry to `registry.json`:

```bash
shasum -a 256 <company>/<name>-playwright.js | awk '{print "sha256:" $1}'
shasum -a 256 <company>/<name>-playwright.json | awk '{print "sha256:" $1}'
```

Add to the `connectors` array in `registry.json` and update `lastUpdated`.

### Step 6 — Test

```bash
node test-connector.cjs ./<company>/<name>-playwright.js           # headed (visible)
node test-connector.cjs ./<company>/<name>-playwright.js --headless # headless
```

## Scoped Result Format

The result object uses `platform.scope` keys. The frontend auto-detects scoped keys (any key containing `.` that isn't metadata) and POSTs each to `POST /v1/data/{scope}`.

```javascript
const result = {
  'platform.profile': { /* profile data */ },
  'platform.posts':   { /* posts data */ },
  exportSummary: { count: 42, label: 'items', details: '1 profile, 41 posts' },
  timestamp: new Date().toISOString(),
  version: '1.0.0-playwright',
  platform: 'platform-name',
};
await page.setData('result', result);
```

`exportSummary` is **required** — the UI displays it. Metadata keys (`exportSummary`, `timestamp`, `version`, `platform`) are not treated as scopes.

## Guidelines

- **Credentials stay on-device.** Never send tokens or passwords to external servers.
- **Prefer API fetch over DOM scraping.** APIs are more stable.
- **Avoid CSS class names** for selectors — platforms obfuscate them. Use structural selectors, ARIA roles, data attributes, semantic HTML.
- **Use `page.setProgress()`** for long exports so users see what's happening.
- **Handle errors gracefully.** Use `page.setData('error', message)` with clear messages.
- **Rate-limit API calls.** Add `page.sleep()` between requests to avoid 429s.
- **Test pagination edge cases** — empty results, single page, large datasets.
- **All `page.evaluate()` calls take a JS string**, not a function. Variables from the connector scope must be interpolated via `JSON.stringify()`.

## Reference Connectors

| Connector | Pattern | Best example of |
|-----------|---------|-----------------|
| `linkedin/linkedin-playwright.js` | REST API | API fetch with CSRF, parallel calls, clean error handling |
| `openai/chatgpt-playwright.js` | REST API + Network capture | Auth token extraction, parallel pagination, hybrid approach |
| `github/github-playwright.js` | DOM scraping | Structural selectors, pagination, text parsing |
| `meta/instagram-playwright.js` | Network capture | `captureNetwork()` usage, GraphQL interception |
| `spotify/spotify-playwright.js` | GraphQL + custom auth | Complex auth (TOTP), dynamic query hashes |
