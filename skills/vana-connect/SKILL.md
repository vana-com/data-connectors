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

If `~/.dataconnect/playwright-runner/index.cjs` or `~/.dataconnect/run-connector.cjs` does not exist, setup is needed. Tell the user: "I need to do a one-time setup first — this downloads a browser engine and some dependencies to `~/.dataconnect/`. It'll take about a minute." Then follow `SETUP.md` (co-located with this file).

## Flow

### 1. Find a connector

```bash
node scripts/fetch-connector.cjs <platform>
```

This searches the registry and downloads the connector + metadata + schemas in one step. It prints JSON: `{ "found": true, "connectorPath": "..." }` on success, `{ "found": false }` if no connector exists.

If found, let the user know there's an existing connector and this should be quick.

**If no connector exists for the platform,** tell the user you'll build one — this involves researching the platform's data APIs, writing the extraction code, and testing it. Let them know it'll take a bit and they're welcome to do something else while you work. Then read `CREATE.md` and follow it. Continue from step 2 with the newly created connector.

### 2. Read the connector

Before running, read the connector script to understand:
- What URL it starts from (`page.goto()` or `connectURL` in metadata)
- Whether it uses `requestInput` (batch-compatible) or `showBrowser`/`promptUser` (browser login)
- What data it collects

### 3. Run it

```bash
node ~/.dataconnect/run-connector.cjs <connector-path> [start-url]
node ~/.dataconnect/run-connector.cjs <connector-path> [start-url] --inputs '{"username":"x","password":"y"}'
```

**Stdout** is line-delimited JSON:

| type | meaning | action |
|------|---------|--------|
| `need-input` | Connector needs credentials or 2FA | Ask user, write response file (see below) |
| `legacy-auth` | Legacy auth, can't run headless | See legacy section |
| `result` | Data saved to `resultPath` | Read the file |
| `error` | Failure | Report to user |

**Exit codes:** 0 = success, 2 = needs input, 3 = legacy auth, 1 = error.

### 4. Handle auth

1. Check if `~/.dataconnect/browser-profiles/{script-filename}/` exists -- try without `--inputs` first (session may still be valid)
2. If `need-input` appears in stdout: the connector is paused, waiting for input. Two options:

   **Option A (preferred): File-based response.** The `need-input` message includes `pendingInputPath` and `responseInputPath`. Ask the user for the requested fields, then write the response as JSON to `responseInputPath`. The connector resumes automatically — no restart needed. This works for multi-step auth (credentials first, then 2FA).

   ```bash
   # Connector emits: {"type":"need-input","message":"Enter credentials","pendingInputPath":"~/.dataconnect/pending-input.json","responseInputPath":"~/.dataconnect/input-response.json",...}
   # After asking the user, write the response:
   echo '{"username":"alice","password":"secret"}' > ~/.dataconnect/input-response.json
   # Connector picks it up within 1 second and continues.
   # If it later needs 2FA, another need-input appears — write again.
   ```

   **Option B: Pre-supply with `--inputs`.** If you know all inputs upfront, pass them at launch. Fields are consumed as each `requestInput` call is made.

   ```bash
   node ~/.dataconnect/run-connector.cjs <connector-path> --inputs '{"username":"x","password":"y"}'
   ```

**TOTP codes expire in ~30 seconds.** Write the response file immediately after receiving a code.

**Sessions persist.** Cookies saved in browser profiles last days to weeks.

#### Legacy connectors

Exit code 3 means the connector uses `showBrowser`/`promptUser` instead of `requestInput`:

1. Try without `--inputs` -- if a browser profile exists, login may be skipped.
2. Check for a migrated version on the `main` branch.
3. Write a login script to establish a session, then run the stock connector.

### 5. Present results and offer to contribute

On success, collected data is at the output path (default: `~/.dataconnect/last-result.json`). Read the file and summarize for the user in human terms (see "Communicating with the user" below).

**If you built a new connector** (not one from the registry), before offering to contribute, review the connector against the **Quality review** checklist in `CREATE.md > Success Criteria`. Fix any issues first — remove debug code, support all login methods, clean the data, enrich schemas. The connector must be production-quality before contribution, not "works for this one test."

Then run validation:

```bash
node scripts/validate.cjs <company>/<name>-playwright.js --check-result ~/.dataconnect/last-result.json
```

If validation passes and the quality review is clean, ask the user:

> "Want to share this connector so others can connect their [Platform] data too? Contributing means the community helps maintain it when [Platform] changes their site."

If yes, run `node scripts/validate.cjs <company>/<name>-playwright.js --contribute`. If no, move on. Do not ask again.

### 6. Suggest what to do with the data

After the contribution question is resolved (or if using an existing connector), suggest use cases from `RECIPES.md`: user profile generation, personal knowledge base, data backup, cross-platform synthesis, activity analytics.

## Communicating with the user

The user can't see what you're doing behind the scenes. Keep them informed at key moments:

1. **Before asking for credentials**, explain the approach and reassure on privacy:
   - "I'll connect to [Platform] using a local browser on your machine. Your credentials stay local — nothing is sent to any server except [Platform] itself."
   - If using an API key: "This uses [Platform]'s API key. You can find it at [location]. The key stays on your machine."

2. **During long operations** (building a connector, collecting paginated data), give brief progress updates. Don't go silent for more than ~30 seconds.

3. **After collection**, summarize results in human terms — not file paths:
   - Good: "Connected! I collected 249 issues, 63 projects, 9 teams, and your profile from Linear."
   - Bad: "Data saved to ~/.dataconnect/last-result.json"
   - Read the result file and build the summary from `exportSummary` and the scoped keys.

4. **On failure**, explain what went wrong and what the user can do:
   - Auth failed → "Login didn't work. Can you double-check your credentials?"
   - Platform API changed → "The connector couldn't find the expected data. The platform may have changed their site."

## Rules

1. **Ask before saving** -- no writes to user profile without approval
2. **Never log credentials** -- no echo, print, or output of secrets
3. **One platform at a time**
4. **Check session first** -- try without credentials if a browser profile exists
5. **Read connectors before running them**
