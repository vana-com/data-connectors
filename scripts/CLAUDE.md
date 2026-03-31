# Data Connector Scripts

This is a self-contained environment for autonomously creating, testing, and validating
data connectors. Connectors are Playwright scripts that export user data from web platforms.

## Directory Layout

```
data-connectors/                    ← repo root
├── connectors/
│   └── <company>/                  # Connector files go HERE
│       ├── <name>-playwright.js
│       └── <name>-playwright.json
├── schemas/                        # Schemas go HERE (repo root level)
│   └── <platform>.<scope>.json
├── registry.json                   # Connector registry (update in Step 7)
│
└── scripts/                        ← working directory
    ├── create-connector.sh         # Entry point — run this
    ├── capture-session.cjs         # Human-in-the-loop login
    ├── test-connector.cjs          # Runs connector against real browser
    ├── validate-connector.cjs      # Validates structure + output
    ├── format-stream.cjs           # Formats streaming output
    ├── reference/                  # Templates and API docs
    ├── sessions/                   # Captured sessions (gitignored)
    └── .env                        # Credentials (USER_LOGIN_X, USER_PASSWORD_X)
```

**IMPORTANT:** Connector files and schemas go in the **connectors/** directory (repo root level),
not inside `scripts/`. Use `../connectors/` paths when creating them. The scripts directory is
only for tooling — the output lives alongside existing connectors.

## How It Works

1. Connectors are self-contained JS files that use the injected `page` object (not raw Playwright)
2. `page.evaluate('js string')` runs JS in the browser — takes a STRING, not a function
3. Variables pass into evaluate via `JSON.stringify()` interpolation
4. Three-tier login: session from profile → automated credentials → manual login via headed browser
5. Two-phase flow: Phase 1 (login) → Phase 2 (headless data collection)
6. Result uses scoped keys like `"platform.scope"` (e.g., `"instagram.profile"`)

## Key Commands

```bash
# End-to-end: session capture + build connector (one command)
./create-connector.sh uber --login-url https://auth.uber.com "Extract trip history"
./create-connector.sh instagram                              # simple auth, uses .env

# Capture a session for platforms with complex auth (Google, Uber, etc.)
node capture-session.cjs <platform> <login-url>
node capture-session.cjs google https://accounts.google.com

# Validate connector structure (no browser needed)
node validate-connector.cjs ../connectors/<company>/<name>-playwright.js

# Test connector (runs real browser)
node test-connector.cjs ../connectors/<company>/<name>-playwright.js --headless

# Validate output data quality
node validate-connector.cjs ../connectors/<company>/<name>-playwright.js --check-result ./connector-result.json
```

## Session Capture (Human-in-the-Loop Login)

For platforms where automated login fails (CAPTCHAs, Cloudflare, 2FA, OAuth):

1. Run `node capture-session.cjs <platform> <login-url>` — opens a headed browser
2. Log in manually in the browser window (handles any auth complexity)
3. Login is detected automatically via URL change + cookie increase
4. Session persists in `~/.dataconnect/browser-profiles/<platform>-playwright/`
5. Subsequent connector tests automatically reuse the session (shared profile)

The browser profile is shared by filename: both `sessions/<platform>-playwright.js` (capture)
and `connectors/<company>/<platform>-playwright.js` (real connector) use profile `<platform>-playwright`.

## Three-Tier Login Strategy

Connectors use a cascading login approach:

| Tier | Method | When |
|------|--------|------|
| 1 | Session from browser profile | Previous login persisted (capture-session or prior run) |
| 2 | Automated credentials | `USER_LOGIN_X`/`USER_PASSWORD_X` in `.env` — simple login forms |
| 3 | Manual login via `page.promptUser` | Fallback — opens headed browser, user logs in |

Tier 3 ensures connectors always work for end users, even without pre-captured sessions.

## Critical: page.evaluate() takes a STRING

```javascript
// WRONG — will silently fail
await page.evaluate(() => document.title);

// CORRECT
await page.evaluate(`document.title`);

// CORRECT — with variable interpolation
const url = '/api/data';
await page.evaluate(`fetch(${JSON.stringify(url)})`);
```
