---
name: auto-create-connector
description: >
  Autonomously create, test, and validate a data connector for any web platform — end to end.
  Use when asked to "auto-create a connector", "automatically build a connector",
  or when a connector needs to be created from scratch and tested without manual guidance.
  Triggers on: "auto-create", "auto connector", "create and test connector",
  "build connector end to end", "generate connector".
---

# Autonomous Data Connector Creator

Create data connectors end-to-end with minimal human intervention. The agent writes a
Playwright connector script, tests it against the live site, validates the output, and
iterates until quality. For platforms with complex auth (Google, Uber, Cloudflare-protected
sites), the agent asks the user to log in once via a headed browser, then works autonomously.

## Input

- **Platform name** (required): e.g., "Twitter", "Reddit", "Notion"
- **Data description** (optional): what data to extract. If not specified, extract all
  commonly useful personal data (profile, content, settings).

## Authentication Strategy

### Three-tier login (cascading)

| Tier | Method | Best for |
|------|--------|----------|
| 1 | Session from browser profile | All platforms — reuses previous login |
| 2 | Automated credentials (`.env`) | Simple login forms (LinkedIn, Spotify) |
| 3 | Manual login via capture-session | Complex auth (Google, Uber, Cloudflare, 2FA) |

### Credentials in `.env`

```
USER_LOGIN_TWITTER=user@example.com
USER_PASSWORD_TWITTER=secretpassword
```

Pattern: `USER_LOGIN_<PLATFORM_UPPER>` and `USER_PASSWORD_<PLATFORM_UPPER>`.

### Session Capture (for complex auth)

For platforms where automated login will likely fail (Google, Uber, Amazon, etc.):

```bash
node capture-session.cjs <platform> <login-url>
```

This opens a headed browser. The user logs in manually (handles CAPTCHAs, 2FA, OAuth).
The session persists in `~/.dataconnect/browser-profiles/<platform>-playwright/` and is
automatically reused by the connector during testing.

## Workflow

Execute steps IN ORDER. Do not skip validation. Do not skip testing.

---

### Step 1 — Research the Platform

**Goal:** Understand the platform's data landscape, login flow, and extraction strategy.

**Actions (do all of these):**

1. **Web search** for the platform's APIs:
   - `"<platform> API documentation"` or `"<platform> developer API"`
   - `"<platform> internal API endpoints"` or `"<platform> graphql endpoint"`
   - `"<platform> data export"` or `"<platform> GDPR data download"`
   - Look for open-source scrapers/connectors to understand known API patterns

2. **Identify these specifics:**
   - **Login URL** (e.g., `https://platform.com/login`)
   - **Login form selectors** — input fields for username/email, password, and the submit button.
     Use stable selectors: `input[name="username"]`, `input[type="password"]`, `button[type="submit"]`.
     Note if login is multi-step (email first, then password on next page).
   - **Logged-in selector** (`connectSelector`) — CSS selector only visible post-login
   - **Available API endpoints** — REST, GraphQL, or network requests during browsing
   - **Auth mechanism** — cookies, CSRF tokens, bearer tokens, session storage
   - **Data categories** to export (profile, posts, settings, history, etc.)
   - **Rate limiting** concerns

3. **Choose extraction strategy** (in order of preference):
   - **A: REST API fetch** — platform has discoverable REST endpoints (most reliable)
   - **B: Network capture** — platform uses GraphQL/XHR during page navigation
   - **C: DOM scraping** — no API available, data only in rendered HTML (last resort)

4. **Define scopes** — what data categories to export. Each becomes a `platform.scope` key.

**Optional — Browser-based API discovery:**
If web search doesn't reveal clear APIs, use Chrome browser automation tools to:
1. Navigate to the platform
2. Use `read_network_requests` to discover API endpoints fired during normal browsing
3. Inspect page structure with `get_page_text` or `read_page` for selector identification

**Save your research findings** — you'll reference them when writing the connector.

---

### Step 1.5 — Ensure Session (if needed)

**Goal:** Make sure a valid browser session exists for platforms with complex auth.

**Determine if session capture is needed:**
- **YES** if the platform uses: OAuth (Google, GitHub SSO), 2FA/MFA, CAPTCHAs, Cloudflare
  protection, multi-step login, phone verification, or device-based auth
- **YES** if the platform is known to block automated login (Google, Uber, Amazon, Apple, etc.)
- **NO** if the platform has a simple email+password form (LinkedIn, Spotify, Reddit, etc.)

**If session capture IS needed:**

1. Check for existing session:
   ```bash
   ls sessions/<platform>.json 2>/dev/null && echo "Session exists" || echo "No session"
   ```

2. Check if the browser profile exists:
   ```bash
   ls ~/.dataconnect/browser-profiles/<platform>-playwright/ 2>/dev/null && echo "Profile exists" || echo "No profile"
   ```

3. If no session/profile, tell the user and run capture:
   ```bash
   node capture-session.cjs <platform> <login-url> --timeout 300
   ```
   This opens a headed browser. Wait for the user to log in (up to 5 minutes).
   Use `--timeout 600` for slower platforms. Use `--check-url <url>` if auto-detection
   struggles (e.g., `--check-url myaccount.google.com`).

4. Verify the session was captured:
   ```bash
   cat sessions/<platform>.json | head -5
   ```

**If session capture is NOT needed:** skip to Step 2.

---

### Step 2 — Create Connector Files

**Read these reference files** for patterns, API reference, and templates:
- `reference/PATTERNS.md` — extraction pattern examples (REST API, network capture, DOM scraping)
- `reference/PAGE-API.md` — complete `page` API reference
- `reference/templates/connector-script.js` — starter template with automated login
- `reference/templates/connector-metadata.json` — metadata template
- `reference/templates/schema.json` — schema template

**IMPORTANT: File locations.** The scripts directory is at `scripts/`. Connector files go in the
**connectors/** directory at the repo root:

```
data-connectors/              ← repo root
├── connectors/
│   └── <company>/            ← connector files go HERE
│       ├── <name>-playwright.js
│       └── <name>-playwright.json
├── schemas/                  ← schemas go HERE
│   └── <platform>.<scope>.json
├── registry.json             ← update this in Step 7
└── scripts/                  ← you are here (working directory)
```

**Create these files:**

1. **`../connectors/<company>/<name>-playwright.json`** — Metadata file
   - Use template: `reference/templates/connector-metadata.json`
   - `connectSelector` is CRITICAL — must only match when user is logged in
   - Include `scopes` array with all data categories

2. **`../connectors/<company>/<name>-playwright.js`** — Connector script
   - Use template: `reference/templates/connector-script.js`
   - MUST implement three-tier login: (1) session from profile, (2) automated credentials, (3) manual via `page.promptUser`
   - SHOULD read credentials from `process.env.USER_LOGIN_<PLATFORM>` / `process.env.USER_PASSWORD_<PLATFORM>` for tier 2
   - MUST handle all login tiers gracefully — never hard-fail if credentials are missing
   - MUST use `page.evaluate('string')` — NOT `page.evaluate(() => ...)` (function refs don't work)
   - MUST interpolate variables with `JSON.stringify()` into evaluate strings
   - MUST include error handling for API failures
   - MUST include `page.setProgress()` calls for long operations
   - MUST include `exportSummary` with count, label, details
   - SHOULD rate-limit API calls with `page.sleep(300-1000)` between requests

3. **`../schemas/<platform>.<scope>.json`** (schemas remain at repo root level) — One per scope
   - Use template: `reference/templates/schema.json`
   - Define the exact shape of data each scope produces
   - Use `additionalProperties: false` for strict validation
   - Mark truly required fields as `required`

#### Three-Tier Login Pattern

The connector MUST implement cascading login:

```javascript
const PLATFORM_LOGIN = process.env.USER_LOGIN_PLATFORMNAME || '';
const PLATFORM_PASSWORD = process.env.USER_PASSWORD_PLATFORMNAME || '';

// ... checkLoginStatus() and performLogin() defined above ...

// In the main flow:
let isLoggedIn = await checkLoginStatus();

// Tier 1: Session from browser profile (automatic)
if (isLoggedIn) {
  await page.setData('status', 'Session restored from browser profile');
}

// Tier 2: Automated login with .env credentials
if (!isLoggedIn && PLATFORM_LOGIN && PLATFORM_PASSWORD) {
  await performLogin();
  isLoggedIn = await checkLoginStatus();
}

// Tier 3: Manual login via headed browser (always works)
if (!isLoggedIn) {
  await page.showBrowser('https://platform.com/login');
  await page.promptUser(
    'Please log in to Platform. Login will be detected automatically.',
    async () => await checkLoginStatus(),
    2000
  );
  isLoggedIn = true;
}

await page.goHeadless();
// ... data collection ...
```

**Automated login tips (for Tier 2):**
- **Multi-step login** (email → next page → password): split into two fills with navigation between
- **React/Vue apps** that ignore `.value =`: use `nativeInputValueSetter` pattern:
  ```javascript
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeInputValueSetter.call(emailInput, ${loginStr});
  emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  ```
- **CAPTCHA/2FA**: Tier 3 handles this automatically — user logs in manually

---

### Step 3 — Validate Structure

Run the structural validator:

```bash
node validate-connector.cjs ../connectors/<company>/<name>-playwright.js
```

This checks:
- Metadata has all required fields
- Script reads credentials from process.env
- Script has automated login logic
- Script uses correct page.evaluate() syntax (strings, not functions)
- No obfuscated CSS selectors
- Scoped result keys are present
- Schemas exist for declared scopes

**Fix ALL errors before proceeding.** Warnings are advisory.
Re-run the validator after each fix until the report shows `"valid": true`.

---

### Step 4 — Test

**Check if session or credentials are available:**
```bash
# Check for captured session (from Step 1.5)
ls ~/.dataconnect/browser-profiles/<platform>-playwright/ 2>/dev/null && echo "Session profile exists" || echo "No session profile"

# Check for .env credentials
grep -q "USER_LOGIN_<PLATFORM_UPPER>" .env 2>/dev/null && echo "Credentials found" || echo "No credentials"
```

**Run the connector:**

```bash
# If session profile exists, headless mode works (session auto-restored):
node test-connector.cjs ../connectors/<company>/<name>-playwright.js --headless

# If no session and no credentials, run headed (Tier 3 manual login will trigger):
node test-connector.cjs ../connectors/<company>/<name>-playwright.js
```

**What happens:**
1. The playwright-runner spawns a browser (headless or headed)
2. The connector tries three-tier login:
   - Tier 1: Checks for existing session in browser profile
   - Tier 2: Tries automated login with .env credentials (if available)
   - Tier 3: Opens headed browser for manual login (if needed)
3. Data collection: fetches all scoped data
4. Result is saved to `./connector-result.json`

**If the playwright-runner is not found:** The test-connector.cjs will show an error.
Set `PLAYWRIGHT_RUNNER_DIR` env var pointing to the playwright-runner directory.

**Monitor the test output for:**
- `[error]` messages — connector has bugs
- `[status] COMPLETE` — success, check the result file
- `[status] ERROR` — failure, read the error message
- `WAITING_FOR_USER` — connector needs manual login (Tier 3)
- Process hanging — likely a missing `await` or infinite loop

---

### Step 5 — Validate Output

After the test produces `connector-result.json`, validate it:

```bash
node validate-connector.cjs ../connectors/<company>/<name>-playwright.js --check-result ./connector-result.json
```

This checks:
- All declared scopes are present in the output
- Each scope has non-empty data
- Array fields have items (not empty arrays)
- exportSummary present with count, label, details
- timestamp, version, platform metadata present
- Data conforms to JSON schemas (type checking, required fields)

**All errors must pass.** If output validation fails, proceed to Step 6.

---

### Step 6 — Iterate

If testing or output validation fails:

1. **Read the validation report** — identify what failed
2. **Read the test output** — look for error messages, unexpected behavior
3. **Diagnose the root cause:**
   - Login failed? → Check form selectors, try `nativeInputValueSetter` pattern, check for multi-step login
   - API returning errors? → Check endpoint URL, auth headers, CSRF token handling
   - Empty data? → API response format may differ from expected; add debug logging
   - Schema violations? → Data shape doesn't match schema; fix schema or data transform
   - Script crash? → Check for missing awaits, null references, syntax errors in evaluate strings
4. **Fix the connector script** (and/or schemas)
5. **Re-run the test:** `node test-connector.cjs ../connectors/<company>/<name>-playwright.js --headless`
6. **Re-validate output**
7. **Repeat until all checks pass**

**Maximum 3 iterations.** If still failing after 3 attempts, report what's wrong and
ask for guidance rather than continuing to loop.

**Debugging tips:**
- Add `await page.setData('status', '[DEBUG] ' + JSON.stringify(data));` to log intermediate values
- Check if the API requires specific headers (CSRF, cookies, content-type)
- Verify the platform's API response shape by logging the raw response
- Test API endpoints manually with `page.evaluate` + `fetch` before building the full flow

---

### Step 7 — Finalize & Register

Once all validations pass:

1. **Generate checksums:**
   ```bash
   shasum -a 256 ../connectors/<company>/<name>-playwright.js | awk '{print "sha256:" $1}'
   shasum -a 256 ../connectors/<company>/<name>-playwright.json | awk '{print "sha256:" $1}'
   ```

2. **Add entry to `../registry.json`** (paths in the registry use `connectors/` prefix):
   Read the existing registry, then add a new entry to the `connectors` array:
   ```json
   {
     "id": "<name>-playwright",
     "company": "<company>",
     "version": "1.0.0",
     "name": "<PlatformDisplayName>",
     "description": "Exports your <Platform> <data description> using Playwright browser automation.",
     "files": {
       "script": "connectors/<company>/<name>-playwright.js",
       "metadata": "connectors/<company>/<name>-playwright.json"
     },
     "checksums": {
       "script": "sha256:<script_checksum>",
       "metadata": "sha256:<metadata_checksum>"
     }
   }
   ```
   Also update the `lastUpdated` field to today's date.

3. **Report success** with:
   - Path to all created files (connector, metadata, schemas)
   - Validation report summary
   - Data collected (scope names, item counts)
   - Registry entry added
   - Instructions for creating a PR (see below)

4. **PR instructions** — tell the user:
   ```
   To create a pull request:
     cd .. && git add connectors/<company>/ schemas/ registry.json
     git commit -m "feat: add <platform> connector"
     git push origin <branch>
     gh pr create --title "feat: add <platform> connector"
   ```

---

## Success Criteria

A connector is COMPLETE when ALL of these are true:

- [ ] Connector files created at `../connectors/<company>/` (NOT inside `scripts/`)
- [ ] Schema files created at `../schemas/` (NOT inside `scripts/`)
- [ ] Metadata JSON has all required fields including scopes
- [ ] Script implements three-tier login (session → automated → manual via promptUser)
- [ ] Script handles all login tiers gracefully (never hard-fails on missing credentials)
- [ ] `node validate-connector.cjs` exits with code 0 (structure valid)
- [ ] `node test-connector.cjs --headless` completes without errors
- [ ] `node validate-connector.cjs --check-result` exits with code 0 (output valid)
- [ ] All declared scopes produce non-empty, schema-compliant data
- [ ] exportSummary has accurate count and details
- [ ] Registry entry added to `../registry.json` with correct checksums

## Critical Rules

1. **`page.evaluate()` takes a STRING** — `page.evaluate('...')` not `page.evaluate(() => ...)`
2. **Variable interpolation** — `JSON.stringify()` to pass variables into evaluate strings
3. **Never use obfuscated CSS classes** — no `.x1lliihq`, `.css-1dbjc4n`. Use ARIA roles, data attributes, semantic HTML
4. **Always rate-limit** — `page.sleep(300-1000)` between API calls
5. **Always handle errors** — check for `_error` or non-ok responses in API calls
6. **IIFE wrapper required** — script body must be `(async () => { ... })()`
7. **Credentials stay on-device** — never send tokens/passwords to external servers
8. **Credentials from .env** — read via `process.env.USER_LOGIN_<PLATFORM>` / `process.env.USER_PASSWORD_<PLATFORM>` (for Tier 2)
9. **Always include Tier 3 fallback** — `page.promptUser` for manual login ensures connectors work even without credentials or sessions
