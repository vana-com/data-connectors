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

Fully autonomous, zero human-in-the-loop connector creation. The agent writes a Playwright
connector script, tests it against the live site using credentials from `.env`, validates
the output, iterates until quality, and caches the result for deterministic reuse.

## Input

- **Platform name** (required): e.g., "Twitter", "Reddit", "Notion"
- **Data description** (optional): what data to extract. If not specified, extract all
  commonly useful personal data (profile, content, settings).

## Credentials Convention

Credentials are stored in `.env` at the repo root:

```
USER_LOGIN_TWITTER=user@example.com
USER_PASSWORD_TWITTER=secretpassword
```

Pattern: `USER_LOGIN_<PLATFORM_UPPER>` and `USER_PASSWORD_<PLATFORM_UPPER>`.
The platform name is uppercased (e.g., `LINKEDIN`, `REDDIT`, `TWITTER`).

The connector script reads these via `process.env` and performs automated login —
filling the form fields programmatically and submitting. No manual browser interaction.

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

### Step 2 — Create Connector Files

**Read these files** for patterns, API reference, and templates:
- `.claude/skills/data-connector/SKILL.md` — overall structure and workflow
- `.claude/skills/data-connector/PATTERNS.md` — extraction pattern examples
- `.claude/skills/data-connector/PAGE-API.md` — complete page API reference

**Read the MOST SIMILAR existing connector** as your primary reference:

| If your platform...          | Read this connector                        |
|------------------------------|--------------------------------------------|
| Has REST APIs                | `connectors/linkedin/linkedin-playwright.js` (299 lines, cleanest example) |
| Uses GraphQL/XHR             | `connectors/meta/instagram-playwright.js` (network capture) |
| Needs DOM scraping           | `connectors/github/github-playwright.js` (structural selectors) |
| Needs auth token extraction  | `connectors/openai/chatgpt-playwright.js` (bearer tokens) |
| Has complex auth (TOTP/2FA)  | `connectors/spotify/spotify-playwright.js` |

**Create these files:**

1. **`connectors/<company>/<name>-playwright.json`** — Metadata file
   - Use template: `.claude/skills/data-connector/templates/connector-metadata.json`
   - `connectSelector` is CRITICAL — must only match when user is logged in
   - Include `scopes` array with all data categories

2. **`connectors/<company>/<name>-playwright.js`** — Connector script (see Automated Login Pattern below)
   - MUST use `page.evaluate('string')` — NOT `page.evaluate(() => ...)` (function refs don't work)
   - MUST interpolate variables with `JSON.stringify()` into evaluate strings
   - MUST include error handling for API failures
   - MUST include `page.setProgress()` calls for long operations
   - MUST include `exportSummary` with count, label, details
   - SHOULD rate-limit API calls with `page.sleep(300-1000)` between requests

3. **`schemas/<platform>.<scope>.json`** — One per scope
   - Use template: `.claude/skills/data-connector/templates/schema.json`
   - Define the exact shape of data each scope produces
   - Use `additionalProperties: false` for strict validation
   - Mark truly required fields as `required`

#### Automated Login Pattern

The connector MUST handle login programmatically using credentials from `.env`.
Here is the required pattern:

```javascript
/**
 * <Platform> Connector (Playwright) — Automated Login
 */

// ─── Credentials ─────────────────────────────────────────────
const PLATFORM_LOGIN = process.env.USER_LOGIN_<PLATFORM_UPPER> || '';
const PLATFORM_PASSWORD = process.env.USER_PASSWORD_<PLATFORM_UPPER> || '';

// ─── Login Detection ─────────────────────────────────────────
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        // Check for login form (means NOT logged in)
        const hasLoginForm = !!document.querySelector('input[type="password"]');
        if (hasLoginForm) return false;
        // Check for challenge/2FA pages
        const url = window.location.href;
        if (url.includes('/challenge') || url.includes('/verify')) return false;
        // Check for logged-in indicators
        return !!document.querySelector('LOGGED_IN_SELECTOR');
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Automated Login ─────────────────────────────────────────
const performLogin = async () => {
  const loginStr = JSON.stringify(PLATFORM_LOGIN);
  const passwordStr = JSON.stringify(PLATFORM_PASSWORD);

  await page.goto('https://platform.com/login');
  await page.sleep(2000);

  // Fill login form
  await page.evaluate(`
    (() => {
      const emailInput = document.querySelector('input[name="username"], input[name="email"], input[type="email"]');
      const passwordInput = document.querySelector('input[name="password"], input[type="password"]');
      if (emailInput) {
        emailInput.focus();
        emailInput.value = ${loginStr};
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passwordInput) {
        passwordInput.focus();
        passwordInput.value = ${passwordStr};
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(500);

  // Submit the form
  await page.evaluate(`
    (() => {
      const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) submitBtn.click();
    })()
  `);
  await page.sleep(3000);
};

// ─── Main Export Flow ────────────────────────────────────────
(async () => {
  // ═══ PHASE 1: Automated Login ═══
  await page.setData('status', 'Checking login status...');
  await page.goto('https://platform.com');
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    if (!PLATFORM_LOGIN || !PLATFORM_PASSWORD) {
      await page.setData('error', 'No credentials found. Set USER_LOGIN_<PLATFORM> and USER_PASSWORD_<PLATFORM> in .env');
      return;
    }
    await page.setData('status', 'Logging in...');
    await performLogin();
    await page.sleep(2000);

    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      // Retry once — some platforms need a moment
      await page.sleep(3000);
      isLoggedIn = await checkLoginStatus();
    }
    if (!isLoggedIn) {
      await page.setData('error', 'Automated login failed. Check credentials or login flow may require 2FA/CAPTCHA.');
      return;
    }
    await page.setData('status', 'Login successful');
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ PHASE 2: Data Collection (headless) ═══
  await page.goHeadless();
  // ... fetch data, build result, setData('result', result)
})();
```

**Adapt this pattern** for the specific platform:
- If login is multi-step (email → next page → password), split into two form fills with navigation between
- If the platform uses React/Vue that ignores `.value =`, use `nativeInputValueSetter` pattern:
  ```javascript
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(emailInput, ${loginStr});
  emailInput.dispatchEvent(new Event('input', { bubbles: true }));
  ```
- If the platform has CAPTCHA/2FA, log a clear error — these can't be automated

---

### Step 3 — Validate Structure

Run the structural validator:

```bash
node scripts/validate-connector.cjs ./connectors/<company>/<name>-playwright.js
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

### Step 4 — Test (Fully Automated)

Ensure `.env` has the credentials:
```bash
# Check credentials are set
grep -q "USER_LOGIN_<PLATFORM_UPPER>" .env && echo "Credentials found" || echo "ERROR: Set credentials in .env"
```

Run the connector in headless mode:

```bash
node test-connector.cjs ./connectors/<company>/<name>-playwright.js --headless
```

**What happens (fully automated, no human needed):**
1. The playwright-runner spawns a headless browser
2. The connector reads credentials from `process.env`
3. Automated login: navigates to login page, fills form, submits
4. Data collection: fetches all scoped data
5. Result is saved to `./connector-result.json`

**If the playwright-runner is not found:** The test-connector.cjs will show an error.
The runner lives at `../data-dt-app/playwright-runner/` or set `PLAYWRIGHT_RUNNER_DIR`.
If unavailable, inform the user and provide setup instructions. Do NOT skip testing.

**Monitor the test output for:**
- `[error]` messages — connector has bugs
- `[status] COMPLETE` — success, check the result file
- `[status] ERROR` — failure, read the error message
- Process hanging — likely a missing `await` or infinite loop

---

### Step 5 — Validate Output

After the test produces `connector-result.json`, validate it:

```bash
node scripts/validate-connector.cjs ./connectors/<company>/<name>-playwright.js --check-result ./connector-result.json
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
5. **Re-run the test:** `node test-connector.cjs ./connectors/<company>/<name>-playwright.js --headless`
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

### Step 7 — Finalize

Once all validations pass:

1. **Generate checksums:**
   ```bash
   shasum -a 256 connectors/<company>/<name>-playwright.js | awk '{print "sha256:" $1}'
   shasum -a 256 connectors/<company>/<name>-playwright.json | awk '{print "sha256:" $1}'
   ```

2. **Add entry to `registry.json`:**
   ```json
   {
     "id": "<name>-playwright",
     "company": "<company>",
     "version": "1.0.0",
     "name": "<Platform Name>",
     "description": "<what it exports>",
     "files": {
       "script": "connectors/<company>/<name>-playwright.js",
       "metadata": "connectors/<company>/<name>-playwright.json"
     },
     "checksums": {
       "script": "sha256:<hash>",
       "metadata": "sha256:<hash>"
     }
   }
   ```

3. **Update `lastUpdated`** in registry.json to today's ISO date.

---

## Success Criteria

A connector is COMPLETE when ALL of these are true:

- [ ] Metadata JSON has all required fields including scopes
- [ ] Script reads credentials from `process.env` and performs automated login
- [ ] Script handles login failure with clear error message
- [ ] `node scripts/validate-connector.cjs` exits with code 0 (structure valid)
- [ ] `node test-connector.cjs --headless` completes without errors
- [ ] `node scripts/validate-connector.cjs --check-result` exits with code 0 (output valid)
- [ ] All declared scopes produce non-empty, schema-compliant data
- [ ] exportSummary has accurate count and details
- [ ] Registry updated with correct checksums

## Critical Rules

1. **`page.evaluate()` takes a STRING** — `page.evaluate('...')` not `page.evaluate(() => ...)`
2. **Variable interpolation** — `JSON.stringify()` to pass variables into evaluate strings
3. **Never use obfuscated CSS classes** — no `.x1lliihq`, `.css-1dbjc4n`. Use ARIA roles, data attributes, semantic HTML
4. **Always rate-limit** — `page.sleep(300-1000)` between API calls
5. **Always handle errors** — check for `_error` or non-ok responses in API calls
6. **IIFE wrapper required** — script body must be `(async () => { ... })()`
7. **Credentials stay on-device** — never send tokens/passwords to external servers
8. **Credentials from .env only** — read via `process.env.USER_LOGIN_<PLATFORM>` / `process.env.USER_PASSWORD_<PLATFORM>`
