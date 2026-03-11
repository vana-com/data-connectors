# Creating a Connector

Build a data connector for a platform that isn't in the registry yet.

## Prerequisites

Before starting, read these reference docs:

- `reference/PAGE-API.md` -- full `page` object API
- `reference/PATTERNS.md` -- data extraction approaches and code examples

### Script paths

All `node scripts/...` commands below refer to `skills/vana-connect/scripts/` in the data-connectors repo you cloned. Exception: `run-connector.cjs` is installed to `~/.dataconnect/run-connector.cjs` by SETUP.md — use that path when running connectors.

## Connector Format

Scripts are plain JavaScript (CJS), no imports, no require. The runner injects a `page` object. The script body must be an async IIFE preceded by a blank line (the runner matches `\n(async`).

```javascript
(async () => {
  // connector logic here
  await page.setData('result', { 'platform.scope': data });
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

**IMPORTANT: Do not make claims about how a platform works based on your training data or web search alone.** Platforms change their auth flows, API access, and page structure frequently. Your knowledge may be outdated. Always verify by inspecting the actual page (use `page.screenshot()` or navigate to the login page and examine the DOM) before telling the user anything about how login works or what options are available.

### Web search queries

Run these (or similar) searches:

- `"<platform> API endpoints"`, `"<platform> graphql endpoint"`
- `"<platform> internal API"`, `"<platform> developer API"`
- `"<platform> data export"`, `"<platform> GDPR data download"`
- `"<platform> scraper github"` -- open-source scrapers reveal known API patterns

### What to identify

- **Login URL** (e.g. `https://platform.com/login`)
- **Available login methods** -- navigate to the actual login page and inspect it. Many platforms offer multiple options (email/password, Google, Apple, SSO). **List all available methods and ask the user which one they use.** Do not assume or hardcode a single method.
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

### Quality bar

Connectors are shipped to all users, not just the person testing them. Before hardcoding any login flow or extraction path, ask: "would this work for a random user who has never talked to me?" Specifically:

- **Support all common login methods.** If the platform offers email, Google, Apple, and SSO login, the connector should ask the user which method they use and handle each one. Do not hardcode the method that happens to work for your test user.
- **Don't assume how a platform works.** Navigate to the actual login page and inspect it. Your training data may be wrong or outdated about a platform's auth flow.
- **Clean the output.** DOM-extracted data often contains UI artifacts (`[edit]` links, `(edit profile)` text, whitespace from HTML formatting). The output should look like clean data, not a DOM dump.

### Auth pattern

Connectors must support two credential sources:

1. **`process.env`** -- for automated/CI runs. Convention: `USER_LOGIN_<PLATFORM_UPPER>` and `USER_PASSWORD_<PLATFORM_UPPER>`.
2. **`page.requestInput()`** -- for interactive runs where env vars aren't set. This prompts the user through the agent.

When the platform offers multiple login methods (email, Google, Apple, SSO), ask the user which one they use via `requestInput` before attempting login.

Try env first, fall back to requestInput:

```javascript
let username = process.env.USER_LOGIN_PLATFORMNAME || '';
let password = process.env.USER_PASSWORD_PLATFORMNAME || '';

if (!username || !password) {
  const creds = await page.requestInput({
    message: 'Enter your Platform credentials. How do you sign in?',
    schema: {
      type: 'object',
      properties: {
        method: { type: 'string', title: 'Login method (email, google, apple)', default: 'email' },
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
- **Clean DOM-extracted data.** The DOM contains UI affordances (edit buttons, action links), whitespace from HTML formatting, and layout artifacts. Strip these before returning data:
  - Collapse whitespace: `.replace(/\s+/g, ' ').trim()`
  - Remove UI text like `(edit)`, `[edit]`, `(edit profile)` that are interactive elements, not data
  - Separate fields that the DOM combines (e.g., "Male, United States" is gender + location, not one field)
  - Filter out navigation/action elements from lists (e.g., `[edit]` links mixed into shelf names)
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
node scripts/validate.cjs <company>/<name>-playwright.js
```

This checks metadata fields, script patterns (IIFE, login detection, evaluate syntax, scoped keys), and schema files.

Fix all errors before testing. Re-run after each fix until `"valid": true`.

---

## Step 4 -- Test and Validate Output

Run the connector, then validate the output in one go:

```bash
node ~/.dataconnect/run-connector.cjs <company>/<name>-playwright.js [start-url] && node scripts/validate.cjs <company>/<name>-playwright.js --check-result ~/.dataconnect/last-result.json
```

To pre-supply credentials:

```bash
node ~/.dataconnect/run-connector.cjs <company>/<name>-playwright.js --inputs '{"username":"x","password":"y"}' && node scripts/validate.cjs <company>/<name>-playwright.js --check-result ~/.dataconnect/last-result.json
```

**Exit codes for run-connector:** 0 = success, 1 = error, 2 = needs input (missing credentials), 3 = legacy auth (not batch-compatible).

Output validation verifies:

- All declared scopes are present and non-empty
- Array fields have items
- exportSummary has count, label, details
- timestamp, version, platform metadata present
- Data conforms to JSON schemas (type checking, required fields)

All errors must pass before the connector is considered done.

---

## Step 5 -- Iterate

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

## Step 6 -- Enrich Schemas

Schemas are an API contract — app developers build against them. They must be meaningful, not just type stubs.

### 6a. Generate the skeleton

```bash
node scripts/generate-schemas.cjs ~/.dataconnect/last-result.json <platform> [output-dir]
```

This infers types and structure from actual data. It's a starting point, not a finished schema.

### 6b. Enrich from what you know

You have three inputs: the platform's API docs, the actual scraped data (potentially hundreds of records), and your own understanding. Use all three:

1. **Add `description` to every field.** What does this field contain? What's it useful for? A downstream developer should understand the data model without reading the connector code.

2. **Fix `required` fields.** Only mark fields as required if the platform guarantees them for all users. Scan the actual output — if a field is null/missing for some records, it's optional. Don't mark everything required just because your test user had it.

3. **Add `format` hints** where applicable: `"format": "date-time"` for ISO timestamps, `"format": "uri"` for URLs, `"format": "email"` for emails.

4. **Use `additionalProperties: true`** (or omit it). Platforms add new fields over time. Strict `additionalProperties: false` breaks consumers when a platform adds a field. Only use `false` when the schema is the complete, known shape.

5. **Write a meaningful top-level `description`.** Not "GitHub profile data" — "GitHub user profile including bio, follower counts, and repository statistics. Used by apps to display identity and activity summary."

### Example: before and after

Before (from `generate-schemas.cjs`):
```json
{ "type": "string" }
```

After (enriched):
```json
{ "type": "string", "format": "date-time", "description": "When the issue was created (ISO 8601)" }
```

---

## Step 7 -- Register

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
- [ ] `node scripts/validate.cjs` exits 0 (structure valid)
- [ ] `node ~/.dataconnect/run-connector.cjs` completes without errors
- [ ] `node scripts/validate.cjs --check-result` exits 0 (output valid)
- [ ] All declared scopes produce non-empty, schema-compliant data
- [ ] exportSummary has accurate count and details

---

## Contributing Back

After validation passes, the validator will prompt:

> "This connector is ready to share. Run with --contribute to open a PR so others can connect their [Platform] data."

To contribute:

1. Run `node scripts/register.cjs <company>/<name>-playwright.js` to add the registry entry.
2. Run `node scripts/validate.cjs <company>/<name>-playwright.js --contribute`

This scans for hardcoded secrets, creates a branch, commits the connector + schemas + registry entry, and opens a PR. Requires `gh` CLI (preferred) or git credentials.
