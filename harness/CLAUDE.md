# Data Connector Harness

This is a self-contained environment for autonomously creating, testing, and validating
data connectors. Connectors are Playwright scripts that export user data from web platforms.

## Directory Layout

```
harness/
├── create-connector.sh          # Entry point — run this
├── test-connector.cjs           # Runs connector against real browser
├── scripts/
│   └── validate-connector.cjs   # Validates structure + output
├── reference/
│   ├── PAGE-API.md              # Complete page API reference
│   ├── PATTERNS.md              # Extraction patterns (REST, GraphQL, DOM)
│   └── templates/               # Starter templates
│       ├── connector-script.js  # Script template (with automated login)
│       ├── connector-metadata.json
│       └── schema.json
├── schemas/                     # JSON Schemas go here (one per scope)
├── .env                         # Credentials (USER_LOGIN_X, USER_PASSWORD_X)
└── <company>/                   # Created connector files go here
    ├── <name>-playwright.js
    └── <name>-playwright.json
```

## How It Works

1. Connectors are self-contained JS files that use the injected `page` object (not raw Playwright)
2. `page.evaluate('js string')` runs JS in the browser — takes a STRING, not a function
3. Variables pass into evaluate via `JSON.stringify()` interpolation
4. Login is automated: read creds from `process.env`, fill form, submit
5. Two-phase flow: Phase 1 (login) → Phase 2 (headless data collection)
6. Result uses scoped keys like `"platform.scope"` (e.g., `"instagram.profile"`)

## Key Commands

```bash
# Validate connector structure (no browser needed)
node scripts/validate-connector.cjs ./<company>/<name>-playwright.js

# Test connector (runs real browser, auto-login via .env)
node test-connector.cjs ./<company>/<name>-playwright.js --headless

# Validate output data quality
node scripts/validate-connector.cjs ./<company>/<name>-playwright.js --check-result ./connector-result.json
```

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
