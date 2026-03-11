# Creating a Connector

Build a data connector for a platform that isn't in the registry yet.

## Prerequisites

Before starting, read these reference docs:

- `reference/PAGE-API.md` -- full `page` object API
- `reference/PATTERNS.md` -- data extraction approaches and code examples

## Connector Format

Scripts are plain JavaScript (CJS), no imports, no require. The runner injects a `page` object. The script body must be an async IIFE preceded by a blank line (the runner matches `\n(async`).

```javascript
(async () => {
  // connector logic here
  await page.setData('result', { 'platform.scope': data });
  return { success: true };
})()
```

## Reference Connectors

Use existing connectors as models. Match the pattern closest to your target platform:

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

### Web search queries

Run these (or similar) searches:

- `"<platform> API endpoints"`, `"<platform> graphql endpoint"`
- `"<platform> internal API"`, `"<platform> developer API"`
- `"<platform> data export"`, `"<platform> GDPR data download"`
- `"<platform> scraper github"` -- open-source scrapers reveal known API patterns

### What to identify

- **Login URL** (e.g. `https://platform.com/login`)
- **Login form selectors** -- stable selectors for username, password, submit. Use `input[name="..."]`, `input[type="password"]`, `button[type="submit"]`. Note if login is multi-step.
- **Logged-in indicator** -- a CSS selector or API response confirming auth. Becomes `connectSelector` in metadata.
- **Data endpoints** -- REST, GraphQL, or DOM targets
- **Auth mechanism** -- cookies, CSRF tokens, bearer tokens, session storage
- **Rate limits** -- throttling rules, if known
- **Data categories** -- each becomes a `platform.scope` key (e.g. `reddit.profile`, `reddit.posts`)

### Extraction strategy

Research the platform first, then pick the approach with the best user experience. See `reference/PATTERNS.md` for details and code examples.

- **Browser login + in-page fetch** -- user logs in normally, connector calls the platform's API from the page context. Best when the API is same-origin.
- **Browser login + httpFetch** -- user logs in, `closeBrowser()` extracts cookies, `httpFetch()` calls the API from Node.js. Best when the API is cross-origin (CORS).
- **API key + httpFetch** -- user provides an API key via `requestInput`, no browser needed. Best when the platform supports it AND the user would prefer it over logging in.
- **Network capture** -- intercept API responses during page load. Best for platforms that load data during bootstrap.
- **DOM extraction** -- scrape the rendered page. Always works as a last resort.

If unsure, try each approach (max 2 attempts) before moving to the next. The first test run will tell you what works.

---

## Step 2 -- Scaffold the Connector

Generate boilerplate:

```bash
node scripts/scaffold.cjs <platform> [company]
```

This creates `{company}/{platform}-playwright.js`, `{company}/{platform}-playwright.json`, and a stub schema in `schemas/`. Edit these files to implement your connector.

### Auth pattern

Connectors must support two credential sources:

1. **`process.env`** -- for automated/CI runs. Convention: `USER_LOGIN_<PLATFORM_UPPER>` and `USER_PASSWORD_<PLATFORM_UPPER>`.
2. **`page.requestInput()`** -- for interactive runs where env vars aren't set. This prompts the user through the agent.

Try env first, fall back to requestInput:

```javascript
let username = process.env.USER_LOGIN_PLATFORMNAME || '';
let password = process.env.USER_PASSWORD_PLATFORMNAME || '';

if (!username || !password) {
  const creds = await page.requestInput({
    message: 'Enter your Platform credentials',
    schema: {
      type: 'object',
      properties: {
        username: { type: 'string', title: 'Email or username' },
        password: { type: 'string', title: 'Password' }
      },
      required: ['username', 'password']
    }
  });
  username = creds.username;
  password = creds.password;
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

**Platform-specific adaptations:**

- **Multi-step login** (email page, then password page): split into two evaluate+sleep sequences with a navigation between them.
- **React/Vue apps** that ignore `.value =`: use the `nativeInputValueSetter` pattern:
  ```javascript
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeInputValueSetter.call(input, ${loginStr});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  ```
- **2FA**: use `page.requestInput()` to ask for the code. CAPTCHA cannot be automated -- exit with a clear error.

### Key rules

- **`page.evaluate()` takes a string**, not a function. Pass variables in via `JSON.stringify()`.
- **No obfuscated CSS classes** (`.x1lliihq`, `.css-1dbjc4n`). Use ARIA roles, data attributes, semantic HTML.
- **Rate-limit API calls** -- `page.sleep(300-1000)` between requests.
- **Handle errors** -- check `resp.ok`, wrap fetches in try-catch, use `page.setData('error', ...)` for failures.
- **Scoped result keys** -- `platform.scope` format (e.g. `spotify.playlists`).
- **Report progress** -- `page.setProgress({ phase, message })` for long operations.
- **Include exportSummary** -- `{ count, label, details }` in the result object.

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

## Step 3 -- Validate Structure

Run the structural validator:

```bash
node scripts/validate-connector.cjs <company>/<name>-playwright.js
```

This checks metadata fields, script patterns (IIFE, login detection, evaluate syntax, scoped keys), and schema files.

Fix all errors before testing. Re-run after each fix until `"valid": true`.

---

## Step 4 -- Test

Run the connector headless via `run-connector.cjs`:

```bash
node scripts/run-connector.cjs <company>/<name>-playwright.js [start-url]
```

To pre-supply credentials without env vars:

```bash
node scripts/run-connector.cjs <company>/<name>-playwright.js --inputs '{"username":"x","password":"y"}'
```

**Exit codes:** 0 = success, 1 = error, 2 = needs input (missing credentials), 3 = legacy auth (not batch-compatible).

On success, the result is written to `~/.dataconnect/last-result.json`.

---

## Step 5 -- Validate Output

Check that the collected data is correct:

```bash
node scripts/validate-connector.cjs <company>/<name>-playwright.js --check-result ~/.dataconnect/last-result.json
```

This verifies:

- All declared scopes are present and non-empty
- Array fields have items
- exportSummary has count, label, details
- timestamp, version, platform metadata present
- Data conforms to JSON schemas (type checking, required fields)

All errors must pass before the connector is considered done.

---

## Step 6 -- Iterate

If testing or validation fails, fix and retry. **Maximum 2 attempts per extraction rung**, then move to the next rung (see `reference/PATTERNS.md`). If Rung 3 (DOM extraction) fails after 2 attempts, stop and ask for help.

### Diagnosis guide

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Login failed | Wrong selectors, multi-step login not handled | Inspect form with `page.screenshot()`, try `nativeInputValueSetter` |
| API returns 401/403 | Cross-origin auth, query allowlist, or missing CSRF | Move to next extraction rung (see PATTERNS.md) |
| CORS / "Failed to fetch" | Platform blocks cross-origin API calls from page context | Move to Rung 2 or 3 |
| Empty data | API response shape differs from expected | Log raw response with `page.setData('status', '[DEBUG] ' + JSON.stringify(raw))` |
| Schema violations | Data shape mismatch | Fix schema or add a transform step |
| Script crash | Missing await, null ref, bad evaluate string | Check for function refs in evaluate, null checks |
| Timeout (5 min) | Infinite loop or missing await | Add progress logging to find where it stalls |

### Debugging tips

- Use `page.screenshot()` to see what the browser shows at any point.
- Add `page.setData('status', '[DEBUG] ...')` to log intermediate values.
- Test a single API call in isolation with `page.evaluate` + `fetch` before building the full flow.
- Check that the platform's API doesn't require specific headers (CSRF, content-type, custom auth).

---

## Step 7 -- Generate Schemas (optional)

If your schemas are rough drafts, refine them from actual test output:

```bash
node scripts/generate-schemas.cjs ~/.dataconnect/last-result.json <platform> [output-dir]
```

This infers types and structure from actual data and writes draft schema files. Review and adjust before publishing.

---

## Step 8 -- Register

Add the connector to the registry with checksums:

```bash
node scripts/register.cjs <company>/<name>-playwright.js
```

This computes `sha256` checksums for the script and metadata, then adds an entry to `registry.json`.

---

## Success Criteria

A connector is complete when all of these hold:

- [ ] Metadata JSON has all required fields (id, version, name, company, description, connectURL, connectSelector, runtime, scopes)
- [ ] Script tries `process.env` credentials first, falls back to `page.requestInput()`
- [ ] Script handles login failure with a clear error message
- [ ] Script handles 2FA via `page.requestInput()` (if the platform uses it)
- [ ] `node scripts/validate-connector.cjs` exits 0 (structure valid)
- [ ] `node scripts/run-connector.cjs` completes without errors
- [ ] `node scripts/validate-connector.cjs --check-result` exits 0 (output valid)
- [ ] All declared scopes produce non-empty, schema-compliant data
- [ ] exportSummary has accurate count and details

---

## Contributing Back

To submit the connector upstream:

1. All validation passes (Steps 3 and 5).
2. Run `node scripts/register.cjs <company>/<name>-playwright.js` to add the registry entry with checksums.
3. Required files:
   - `<company>/<name>-playwright.js` -- connector script
   - `<company>/<name>-playwright.json` -- metadata
   - `schemas/<platform>.<scope>.json` -- one per scope
   - Updated `registry.json`
4. Open a PR against the connectors repo. Include the validation report output and a summary of what data the connector collects.
