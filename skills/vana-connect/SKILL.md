---
name: vana-connect
description: >
  Connect personal data from any web platform using browser automation.
  Use when: (1) user wants to connect a data source like ChatGPT, Instagram,
  Spotify, or any platform, (2) user says "connect my [platform]",
  (3) user wants to generate or update their profile from connected data.
  Also triggers on: "create a connector for [platform]".
---

# Connect

Connect personal data from web platforms using local browser automation.

## Setup

If `~/.dataconnect/playwright-runner/index.cjs` or `~/.dataconnect/run-connector.cjs` does not exist, read and follow `SETUP.md` (co-located with this file) first.

## Flow

### 1. Find a connector

```bash
curl -s https://raw.githubusercontent.com/vana-com/data-connectors/main/registry.json
```

Search the `connectors` array for the requested platform. If found, download the script:

```bash
BASE_URL="https://raw.githubusercontent.com/vana-com/data-connectors/main"
mkdir -p ~/.dataconnect/connectors/{company}
curl -s "$BASE_URL/{script_path}" > ~/.dataconnect/connectors/{script_path}
```

**If no connector exists for the platform,** read `CREATE.md` and follow it to build one. Then continue from step 2 with the newly created connector.

### 2. Read the connector

Before running, read the connector script to understand:
- What URL it starts from (`page.goto()` or `connectURL` in metadata)
- Whether it uses `requestInput` (batch-compatible) or `showBrowser`/`promptUser` (legacy)
- What data it collects

### 3. Run it

```bash
node ~/.dataconnect/run-connector.cjs <connector-path> [start-url]
node ~/.dataconnect/run-connector.cjs <connector-path> [start-url] --inputs '{"username":"x","password":"y"}'
```

**Stdout** is line-delimited JSON:

| type | meaning | action |
|------|---------|--------|
| `need-input` | Connector needs credentials or 2FA | Ask user, re-run with `--inputs` |
| `legacy-auth` | Legacy auth, can't run headless | See legacy section |
| `result` | Data saved to `resultPath` | Read the file |
| `error` | Failure | Report to user |

**Exit codes:** 0 = success, 2 = needs input, 3 = legacy auth, 1 = error.

### 4. Handle auth

1. Check if `~/.dataconnect/browser-profiles/{script-filename}/` exists -- try without `--inputs` first (session may still be valid)
2. If exit 2 (`need-input`): ask user for the requested fields, re-run with `--inputs`
3. If exit 2 again (2FA): re-run with **all** previously-supplied inputs **plus** the new one: `--inputs '{"username":"...","password":"...","code":"..."}'`. Each run starts a fresh browser -- prior inputs are not remembered.

**TOTP codes expire in ~30 seconds.** Re-run immediately after receiving a code.

**Sessions persist.** Cookies saved in browser profiles last days to weeks.

#### Legacy connectors

Exit code 3 means the connector uses `showBrowser`/`promptUser` instead of `requestInput`:

1. Try without `--inputs` -- if a browser profile exists, login may be skipped.
2. Check for a migrated version on the `main` branch.
3. Write a login script to establish a session, then run the stock connector.

### 5. Use the data

On success, collected data is at `~/.dataconnect/last-result.json`. Keys vary by connector (e.g. `github.profile`, `chatgpt.conversations`).

See `RECIPES.md` for use cases: user profile generation, personal knowledge base, data backup, cross-platform synthesis, activity analytics.

## Rules

1. **Ask before saving** -- no writes to user profile without approval
2. **Never log credentials** -- no echo, print, or output of secrets
3. **One platform at a time**
4. **Check session first** -- try without credentials if a browser profile exists
5. **Read connectors before running them**
