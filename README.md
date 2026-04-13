# Data Connectors

Playwright-based data connectors for [DataConnect](https://github.com/vana-com/data-connect). Each connector exports a user's data from a web platform using browser automation. Credentials never leave the device.

## Connector status

Each connector has a status indicating its maturity level:

- **Stable** -- Production-ready. Well-tested across multiple releases, reliable login and data extraction, complete schemas.
- **Beta** -- Functional but less tested. Works in most cases but may have edge cases or require more login handling.
- **Experimental** -- New or untested. May not work reliably; contributed recently with limited real-world usage.

## Connectors

| Platform | Company | Status | Scopes |
|----------|---------|--------|--------|
| ChatGPT | OpenAI | Stable | chatgpt.conversations, chatgpt.memories |
| GitHub | GitHub | Stable | github.profile, github.repositories, github.starred |
| Instagram | Meta | Stable | instagram.profile, instagram.posts, instagram.ads |
| LinkedIn | LinkedIn | Stable | linkedin.profile, .experience, .education, .skills, .languages, .connections |
| Oura Ring | Oura | Stable | oura.readiness, oura.sleep, oura.activity |
| Spotify | Spotify | Stable | spotify.profile, spotify.savedTracks, spotify.playlists |
| Amazon | Amazon | Beta | amazon.profile, amazon.orders |
| Instagram Ads | Meta | Beta | instagram.ads |
| Shop | Shopify | Beta | shop.orders |
| Uber | Uber | Beta | uber.trips, uber.receipts |
| YouTube | Google | Beta | youtube.profile, youtube.subscriptions, youtube.playlists, youtube.playlistItems, youtube.likes, youtube.watchLater, youtube.history |
| Claude | Anthropic | Experimental | claude.conversations, claude.projects |
| [H-E-B](connectors/heb/) | HEB | Experimental | heb.profile, heb.orders, heb.nutrition |
| Steam | Valve | Experimental | steam.profile, steam.games, steam.friends |
| Whole Foods Market | Whole Foods | Experimental | wholefoods.profile, wholefoods.orders, wholefoods.nutrition |

## Running a connector

```bash
node run-connector.cjs ./connectors/github/github-playwright.js              # JSON output (for agents)
node run-connector.cjs ./connectors/github/github-playwright.js --pretty      # colored output (for humans)
node run-connector.cjs ./connectors/github/github-playwright.js --inputs '{"username":"x","password":"y"}'
```

See [`skills/vana-connect/`](skills/vana-connect/) for the agent skill: setup, running, creating new connectors, and data recipes.

## Repository structure

| Folder | What's inside | Audience |
|--------|--------------|----------|
| **`connectors/`** | All platform connectors (`<company>/<name>-playwright.js` + `.json` + local assets like `icons/`) | Everyone |
| **`scripts/`** | Developer tooling: scaffold, test, validate, session capture | Human developers |
| **`skills/`** | AI agent skill for creating/running connectors (`vana-connect/`) | AI agents (Claude, etc.) |
| **`schemas/`** | JSON Schema definitions, one per scope (`<platform>.<scope>.json`) | Validation |
| **`types/`** | TypeScript type definitions (`connector.d.ts`) | TypeScript consumers |

```
connectors/                        # All platform connectors
├── <company>/
│   ├── <name>-playwright.js       #   Connector script (plain JS)
│   └── <name>-playwright.json     #   Metadata (login URL, selectors, scopes)
│
scripts/                           # Developer tooling (human-driven)
├── create-connector.sh            #   End-to-end connector scaffold + test
├── capture-session.cjs            #   Browser session capture (manual login)
├── test-connector.cjs             #   Run connector against a real browser
├── validate-connector.cjs         #   Structure + output validator
└── reference/                     #   Templates and API docs
│
skills/vana-connect/               # Agent skill (AI-agent-driven)
├── SKILL.md                       #   Skill entry point (setup, connect, recipes)
├── CREATE.md                      #   Full walkthrough for building connectors
└── scripts/                       #   Agent-facing scripts (runner, validator, etc.)
│
schemas/                           # JSON Schema definitions (one per scope)
├── <platform>.<scope>.json
│
registry.json                      # Central registry (checksums, versions, OTA)
run-connector.cjs                  # Symlink → skills/vana-connect/scripts/run-connector.cjs
test-connector.cjs                 # Standalone test runner
create-connector.sh                # Quick autonomous scaffold script
```

### Connectors

Each connector lives in `connectors/<company>/`. A connector bundle keeps its runtime assets together inside that directory. A connector usually consists of:

- **`<name>-playwright.js`** -- the connector script (plain JS, runs inside the Playwright runner sidecar)
- **`<name>-playwright.json`** -- metadata (display name, login URL, selectors, scopes)
- **`icons/...`** -- canonical local icon assets referenced by the manifest via a path relative to that connector directory

Some connectors also include a README with platform-specific setup instructions (e.g., API keys).

### Scripts vs. skills

The repo has two interfaces for building and running connectors. They serve different audiences but share the same connector format and output:

| | `scripts/` | `skills/vana-connect/` |
|---|---|---|
| **Audience** | Human developers at a terminal | AI agents (Claude, etc.) |
| **Entry point** | `scripts/create-connector.sh` | `skills/vana-connect/SKILL.md` |
| **Login** | Manual browser login via `capture-session.cjs` | CLI-driven (`vana connect`) |
| **Testing** | `scripts/test-connector.cjs` | `run-connector.cjs` |
| **When to use** | Local development, debugging, manual QA | Automated connector creation and data export |

Both produce the same connector files (`connectors/<company>/<name>-playwright.js` + `.json`) and use the same schemas, registry, and validation scripts.

---

## How connectors work

Connectors run in a sandboxed Playwright browser managed by the DataConnect app. The runner provides a `page` API object (not raw Playwright). The browser starts headless; connectors call `page.showBrowser()` when login is needed and `page.goHeadless()` after.

### Two-phase architecture

**Phase 1 -- Login (visible browser)**
1. Navigate to the platform's login page (headless)
2. Check if the user is already logged in via persistent session
3. If not, show the browser so the user can log in manually
4. Extract auth tokens/cookies once logged in

**Phase 2 -- Data collection (headless)**
1. Switch to headless mode (browser disappears)
2. Fetch data via API calls, network capture, or DOM scraping
3. Report structured progress to the UI
4. Return the collected data with an export summary

### Scoped result format

Connectors return a scoped result object where data keys use the format `source.category` (e.g., `linkedin.profile`, `chatgpt.conversations`). The frontend auto-detects scoped keys (any key containing a `.` that isn't a metadata field) and POSTs each scope separately to the Personal Server at `POST /v1/data/{scope}`.

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
| **API fetch** via `page.evaluate()` | Platform has REST/JSON APIs | `connectors/openai/chatgpt-playwright.js` |
| **Network capture** via `page.captureNetwork()` | Platform uses GraphQL/XHR that fires on navigation | `connectors/meta/instagram-playwright.js` |
| **DOM scraping** via `page.evaluate()` | No API available, data only in rendered HTML | `connectors/linkedin/linkedin-playwright.js` |

---

## Building a new connector

See [`skills/vana-connect/CREATE.md`](skills/vana-connect/CREATE.md) for the full walkthrough. Summary:

1. **Scaffold:** `node skills/vana-connect/scripts/scaffold.cjs <platform> [company]` -- generates script, metadata, and stub schema
2. **Implement:** Write login + data collection logic (see CREATE.md for auth patterns, extraction strategies, and reference connectors)
3. **Validate structure:** `node scripts/validate-connector.cjs connectors/<company>/<name>-playwright.js`
4. **Test:** `node run-connector.cjs connectors/<company>/<name>-playwright.js --inputs '{"username":"x","password":"y"}'`
5. **Validate output:** `node scripts/validate-connector.cjs connectors/<company>/<name>-playwright.js --check-result ~/.dataconnect/last-result.json`
6. **Register:** `node skills/vana-connect/scripts/register.cjs connectors/<company>/<name>-playwright.js` -- adds entry + checksums to `registry.json`

---

## Page API reference

The `page` object is available as a global in connector scripts. The runner implementation lives in [data-connect/playwright-runner](https://github.com/vana-com/data-connect/tree/main/playwright-runner).

| Method | Description |
|--------|-------------|
| `page.evaluate(jsString)` | Run JS in browser context, return result |
| `page.screenshot()` | Take a JPEG screenshot, returns base64 string |
| `page.requestInput({message, schema?})` | Request data from the driver (credentials, 2FA codes, etc.) |
| `page.goto(url, options?)` | Navigate to URL |
| `page.sleep(ms)` | Wait for milliseconds |
| `page.setData(key, value)` | Send data to host (`'status'`, `'error'`, `'result'`) |
| `page.setProgress({phase, message, count})` | Structured progress for the UI |
| `page.showBrowser(url?)` | Escalate to headed mode; returns `{ headed: true/false }` |
| `page.goHeadless()` | Switch to headless mode (no-op if already headless) |
| `page.promptUser(msg, checkFn, interval)` | Poll `checkFn` until truthy |
| `page.captureNetwork({urlPattern, bodyPattern, key})` | Register a network capture |
| `page.getCapturedResponse(key)` | Get captured response or `null` |
| `page.hasCapturedResponse(key)` | Check if a response was captured |
| `page.clearNetworkCaptures()` | Clear all captures |
| `page.closeBrowser()` | Close browser, keep process for HTTP work |
| `page.httpFetch(url, options?)` | Node.js fetch with auto-injected cookies from the browser session |

### `showBrowser` — headed escalation

`showBrowser` switches the browser to headed mode for cases that require live human interaction (e.g., interactive CAPTCHAs). It returns `{ headed: true }` on success or `{ headed: false }` if the driver doesn't support headed mode. Connectors should check the return value and handle the fallback:

```javascript
const { headed } = await page.showBrowser(url);
if (!headed) {
  // Headed not available — retry, skip, or report error
}
```

For normal login flows, use `requestInput` to ask the driver for credentials without showing a browser:

```javascript
const { email, password } = await page.requestInput({
  message: 'Log in to ChatGPT',
  schema: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', format: 'password' }
    },
    required: ['email', 'password']
  }
});
```

The runner relays the request to the driver (Tauri app, agent, CLI) and resolves with the response. The `schema` field uses JSON Schema — the same format used by OpenAI, Anthropic, and Google for LLM tool definitions. See the [headless-first runner spec](https://github.com/vana-com/data-connect/blob/main/docs/260310-headless-first-runner-spec.md) for the full protocol design.

### Progress reporting

```javascript
await page.setProgress({
  phase: { step: 1, total: 3, label: 'Fetching memories' },
  message: 'Downloaded 50 of 200 items...',
  count: 50,
});
```

- `phase.step` / `phase.total` -- drives the step indicator ("Step 1 of 3")
- `phase.label` -- short label for the current phase
- `message` -- human-readable progress text
- `count` -- numeric count for progress tracking

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

Test connectors without the full DataConnect app. The runner spawns playwright-runner as a child process and outputs JSON protocol messages.

**Prerequisites:** The [DataConnect](https://github.com/vana-com/data-connect) repo cloned alongside this one (the runner auto-detects `../data-dt-app/playwright-runner`), or set `PLAYWRIGHT_RUNNER_DIR` to point to the playwright-runner directory.

```bash
# Run a connector (headed by default, browser visible)
node run-connector.cjs ./connectors/linkedin/linkedin-playwright.js

# Colored, human-readable output
node run-connector.cjs ./connectors/linkedin/linkedin-playwright.js --pretty

# Pre-supply credentials
node run-connector.cjs ./connectors/linkedin/linkedin-playwright.js --inputs '{"username":"x","password":"y"}'

# Run headless (no visible browser)
node run-connector.cjs ./connectors/linkedin/linkedin-playwright.js --headless

# Override the initial URL
node run-connector.cjs ./connectors/linkedin/linkedin-playwright.js --url https://linkedin.com/feed

# Save result to a custom path (default: ./connector-result.json)
node run-connector.cjs ./connectors/linkedin/linkedin-playwright.js --output ./my-result.json
```

The runner reads the connector's sibling `.json` metadata to resolve the `connectURL`. In headed mode, `goHeadless()` becomes a no-op so the browser stays visible throughout.

---

## Contributing

### Adding a new connector

1. Fork this repo
2. Create a branch: `git checkout -b feat/<platform>-connector`
3. Add your files in `connectors/<company>/`:
   - `connectors/<company>/<name>-playwright.js` -- connector script
   - `connectors/<company>/<name>-playwright.json` -- metadata
   - `schemas/<platform>.<scope>.json` -- data schema (optional but encouraged)
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

- **Credentials stay on-device.** Never send tokens or passwords to external servers.
- **Use `page.setProgress()`** to report progress during long exports.
- **Include `exportSummary`** in the result. The UI uses it to display what was collected.
- **Handle errors.** Use `page.setData('error', message)` with clear error messages.
- **Prefer API fetch over DOM scraping.** APIs are more stable than DOM structure.
- **Avoid obfuscated CSS class names.** Use structural selectors, heading text, and content heuristics.
- **Rate-limit API calls.** Add `page.sleep()` between requests.
- **Test pagination edge cases** -- empty results, single page, large datasets.

### Registry checksums

The registry uses SHA-256 checksums to verify file integrity during OTA updates. Always regenerate checksums when modifying connector files:

```bash
shasum -a 256 connectors/<company>/<name>-playwright.js | awk '{print "sha256:" $1}'
shasum -a 256 connectors/<company>/<name>-playwright.json | awk '{print "sha256:" $1}'
```

---

## How the registry works

DataConnect fetches `registry.json` from this repo on app startup and during `npm postinstall`. For each connector listed:

1. Check if local files exist with matching checksums
2. If not, download from `baseUrl/<file_path>` (this repo's raw GitHub URL)
3. Verify SHA-256 checksums match
4. Write to local `connectors/` directory

This enables OTA connector updates without a full app release.
