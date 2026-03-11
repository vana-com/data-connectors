# Creating a Connector

Build a data connector for a platform that isn't in the registry yet.

## Prerequisites

- `reference/PAGE-API.md` -- full `page` object API
- `reference/PATTERNS.md` -- data extraction approaches and code examples

All `node scripts/...` commands refer to `skills/vana-connect/scripts/` in the data-connectors repo. `run-connector.cjs` is at `~/.dataconnect/run-connector.cjs` (installed by SETUP.md).

## Connector Format

Scripts are plain JavaScript (CJS), no imports, no require. The runner injects a `page` object. The script body must be an async IIFE preceded by a blank line (the runner matches `\n(async`).

```javascript
(async () => {
  // connector logic here
  await page.setData('result', { 'platform.scope': data });
})()
```

## Reference Connectors

| Platform   | Strategy           | Rung | Notes                                    |
|------------|--------------------|------|------------------------------------------|
| Reddit     | In-page fetch      | 1    | OAuth-like endpoints, JSON responses     |
| Twitter/X  | Network capture    | 2    | GraphQL via captureNetwork               |
| Instagram  | In-page fetch      | 1    | Cookie auth, pagination                  |
| LinkedIn   | In-page fetch      | 1    | Voyager API, CSRF token required         |
| GitHub     | DOM extraction     | 3    | Server-rendered, no client API           |
| Spotify    | In-page fetch      | 1    | Well-documented public API               |

Look at existing connectors in `~/.dataconnect/connectors/` for working examples.

---

## Step 1 -- Research the Platform

Map the platform's login flow, data APIs, and auth mechanism before writing code.

### Verify by inspecting, not by guessing

Navigate to the platform's login page and take a screenshot before writing any login code. List every login option visible on the page (email, Google, Apple, SSO, etc.) and ask the user which one they use. Your training data about a platform's auth flow may be outdated.

### Web search queries

- `"<platform> API endpoints"`, `"<platform> graphql endpoint"`
- `"<platform> internal API"`, `"<platform> developer API"`
- `"<platform> data export"`, `"<platform> GDPR data download"`
- `"<platform> scraper github"` -- open-source scrapers reveal known API patterns

### What to identify

- **Login URL** and **available login methods** (inspect the actual page)
- **Login form selectors** -- `input[name="..."]`, `input[type="password"]`, `button[type="submit"]`. Note multi-step flows.
- **Logged-in indicator** -- CSS selector or API response confirming auth. Becomes `connectSelector` in metadata.
- **Data endpoints** -- REST, GraphQL, or DOM targets
- **Auth mechanism** -- cookies, CSRF tokens, bearer tokens, session storage
- **Data categories** -- each becomes a `platform.scope` key (e.g. `reddit.profile`)

### Extraction strategy

Pick the approach with the best user experience. See `reference/PATTERNS.md` for details and code examples. Max 2 attempts per approach before moving to the next.

---

## Step 2 -- Scaffold and Implement

```bash
node scripts/scaffold.cjs <platform> [company]
```

### Auth pattern

Two credential sources: `process.env` (automated runs) and `page.requestInput()` (interactive). Try env first, fall back to requestInput. If the platform has multiple login options (discovered via screenshot in Step 1), include a `method` field listing the options you observed:

```javascript
let username = process.env.USER_LOGIN_PLATFORMNAME || '';
let password = process.env.USER_PASSWORD_PLATFORMNAME || '';

if (!username || !password) {
  const creds = await page.requestInput({
    message: 'Enter your Platform credentials.',
    schema: {
      type: 'object',
      properties: {
        method: { type: 'string', title: 'Login method', description: 'List the options you found on the login page' },
        username: { type: 'string', title: 'Email or username' },
        password: { type: 'string', title: 'Password' }
      },
      required: ['username', 'password']
    }
  });
  username = creds.username;
  password = creds.password;
  // Use creds.method to route to the right login flow
}
```

### Login implementation

```javascript
const loginStr = JSON.stringify(username);
const passStr = JSON.stringify(password);

await page.goto('https://platform.com/login');
await page.sleep(2000);

await page.evaluate(`
  (() => {
    const u = document.querySelector('input[name="username"], input[type="email"]');
    const p = document.querySelector('input[type="password"]');
    if (u) { u.focus(); u.value = ${loginStr}; u.dispatchEvent(new Event('input', {bubbles:true})); }
    if (p) { p.focus(); p.value = ${passStr}; p.dispatchEvent(new Event('input', {bubbles:true})); }
  })()
`);
await page.sleep(500);
await page.evaluate(`document.querySelector('button[type="submit"]')?.click()`);
await page.sleep(3000);
```

**Adaptations:**

- **Multi-step login**: split into two evaluate+sleep sequences with a navigation between.
- **React/Vue apps** that ignore `.value =`: use the native setter pattern:
  ```javascript
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeInputValueSetter.call(input, ${loginStr});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  ```
- **2FA**: use `page.requestInput()` to ask for the code.

### Key rules

- `page.evaluate()` takes a string, not a function. Pass variables via `JSON.stringify()`.
- Use ARIA roles, data attributes, semantic HTML for selectors. The validator flags obfuscated class names.
- Rate-limit API calls with `page.sleep(300-1000)` between requests.
- Use scoped result keys: `platform.scope` format (e.g. `spotify.playlists`).
- Include `exportSummary: { count, label, details }` in the result.

### Page API quick reference

```
page.goto(url)                                Navigate
page.evaluate(jsString)                       Run JS in browser, return result
page.sleep(ms)                                Wait
page.requestInput({ message, schema })        Ask user for data (credentials, 2FA)
page.setData(key, value)                      'result' for data, 'error' for failures
page.setProgress({ phase, message })          Progress reporting
page.closeBrowser()                           Close browser, extract cookies
page.httpFetch(url, options?)                  Node.js HTTP (auto-injects cookies)
page.captureNetwork({ key, urlPattern })      Intercept network requests
page.getCapturedResponse(key)                 Retrieve captured response
page.screenshot()                             Base64 JPEG screenshot
```

Full API: `reference/PAGE-API.md`

---

## Step 3 -- Test

Run the connector and validate in one step:

```bash
node scripts/validate.cjs <company>/<name>-playwright.js && \
  node ~/.dataconnect/run-connector.cjs <company>/<name>-playwright.js [start-url] && \
  node scripts/validate.cjs <company>/<name>-playwright.js --check-result ~/.dataconnect/last-result.json
```

The validator checks structure, output quality, debug code, data cleanliness, schema descriptions, and login method diversity. Fix all reported issues and re-run.

If an extraction approach fails after 2 attempts, move to the next rung (see `reference/PATTERNS.md`). Use `page.screenshot()` to see what the browser shows.

---

## Step 4 -- Enrich Schemas

Schemas are an API contract — app developers build against them.

### Generate the skeleton

```bash
node scripts/generate-schemas.cjs ~/.dataconnect/last-result.json <platform> [output-dir]
```

### Enrich from what you know

- Add `description` to every field and `format` hints where applicable (`date-time`, `uri`, `email`). The validator checks description coverage.
- Mark fields `required` only if guaranteed for all users. Use `additionalProperties: true`.
- Write a meaningful top-level `description` — not "GitHub profile data" but "GitHub user profile including bio, follower counts, and repository statistics."

Before (from `generate-schemas.cjs`):
```json
{ "type": "string" }
```

After (enriched):
```json
{ "type": "string", "format": "date-time", "description": "When the issue was created (ISO 8601)" }
```

---

## Step 5 -- Register and Contribute

```bash
node scripts/register.cjs <company>/<name>-playwright.js
node scripts/validate.cjs <company>/<name>-playwright.js --contribute
```

The validator runs all checks including secret scanning before creating a PR. All checks must pass — the validator is the quality gate.
