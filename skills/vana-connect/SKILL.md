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

Connect personal data from web platforms using the `vana` CLI and local browser automation.

## Setup

Prefer an installed `vana` binary when it is available:

```bash
command -v vana
```

If that succeeds, use:

```bash
vana
```

If `vana` is not on `PATH`, fall back to the published canary CLI:

If the user wants the real installed CLI and not a transient package runner, install `vana` first:

```bash
curl -fsSL https://raw.githubusercontent.com/vana-com/vana-connect/main/install/install.sh | sh
```

Then use:

```bash
vana
```

If the installer path is unavailable, the release channel is too old for the needed CLI behavior, or the user is explicitly testing prerelease changes, fall back to the published canary CLI:

```bash
npx -y @opendatalabs/connect@canary
```

If the canary CLI is unavailable or the user is explicitly testing local changes, fall back to:

```bash
node /home/tnunamak/code/vana-connect/dist/cli/bin.js
```

If neither path is available, follow `SETUP.md` in this folder.

Before connecting a source, check runtime state with the highest-priority available CLI:

```bash
vana status --json
```

If `vana` is unavailable, use:

```bash
npx -y @opendatalabs/connect@canary status --json
```

If the runtime is missing, tell the user: "I need to do a one-time setup first. This downloads a browser engine and some dependencies into `~/.dataconnect/` and usually takes about a minute." Then run:

```bash
vana setup --yes
```

If `vana` is unavailable, use:

```bash
npx -y @opendatalabs/connect@canary setup --yes
```

## Flow

### 1. Explore available sources

Use `vana sources --json` if `vana` is installed:

```bash
vana sources --json
```

Otherwise use:

```bash
npx -y @opendatalabs/connect@canary sources --json
```

This is the source of truth for what the CLI can currently connect. Prefer it over inspecting repo files manually.

If the requested platform is present, use the CLI flow below.

**If no connector exists for the platform,** tell the user you'll build one — this involves researching the platform's data APIs, writing the extraction code, and testing it. Let them know it'll take a bit and they're welcome to do something else while you work. Then read `CREATE.md` and follow it.

### 2. Connect with the CLI

Start with the agent-safe probe:

Use `vana connect <platform> --json --no-input` if `vana` is installed:

```bash
vana connect <platform> --json --no-input
```

Otherwise use:

```bash
npx -y @opendatalabs/connect@canary connect <platform> --json --no-input
```

This will:

- ensure the runtime is installed
- resolve and cache the connector
- try a saved session if one exists
- return structured events and a final outcome such as `needs_input`, `legacy_auth`, `connected_local_only`, or `connected_and_ingested`

If the outcome is `needs_input`, rerun interactively:

Use `vana connect <platform>` if `vana` is installed:

```bash
vana connect <platform>
```

Otherwise use:

```bash
npx -y @opendatalabs/connect@canary connect <platform>
```

If the user specifically wants to inspect current state before rerunning, use:

Use `vana status` if `vana` is installed:

```bash
vana status
```

Otherwise use:

```bash
npx -y @opendatalabs/connect@canary status
```

### 3. Handle outcomes

The CLI emits structured JSON events in `--json` mode.

Key outcomes:

- `needs_input`
  The connector needs a live login or another manual step. Explain that you'll rerun interactively.
- `legacy_auth`
  The connector still depends on `showBrowser` / `promptUser`. Explain that this source still needs a headed/manual session path and may not work in fully headless batch mode yet.
- `connected_local_only`
  Data was collected locally but no Personal Server target was available.
- `connected_and_ingested`
  Data was collected and synced to the Personal Server.

If setup, fetch, or run output is truncated, the CLI may point to a full log file under `~/.dataconnect/logs/`. Use that rather than re-running blindly.

### 4. Validate, present results, and offer to contribute

If you built or modified a connector, immediately run validation — before presenting results to the user:

```bash
node scripts/validate.cjs <company>/<name>-playwright.js --check-result ~/.dataconnect/last-result.json
```

Fix any issues the validator reports. The validator checks debug code, login method diversity, schema descriptions, data cleanliness, and more — it is the quality gate. Iterate until validation passes.

Then read the result file and summarize for the user in human terms (see "Communicating with the user" below).

If you built a new connector (not one from the registry), ask the user:

> "Want to share this connector so others can connect their [Platform] data too? Contributing means the community helps maintain it when [Platform] changes their site."

If yes, run `node scripts/validate.cjs <company>/<name>-playwright.js --contribute`. If no, move on.

### 5. Suggest what to do with the data

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
   - Prefer the CLI outcome plus the result file. Build the summary from `exportSummary` and the scoped keys.

4. **On failure**, explain what went wrong and what the user can do:
   - Auth failed → "Login didn't work. Can you double-check your credentials?"
   - Platform API changed → "The connector couldn't find the expected data. The platform may have changed their site."

## Rules

1. **Ask before saving** -- no writes to user profile without approval
2. **Never log credentials** -- no echo, print, or output of secrets
3. **One platform at a time**
4. **Check session first** -- try without credentials if a browser profile exists
5. **Read connectors before running them**
6. **Use the CLI as the primary interface** -- only drop to raw scripts when debugging or updating connector internals

## CLI fallback order

Use this order when choosing the CLI entrypoint:

1. `vana` if it is already installed and on `PATH`
2. `npx -y @opendatalabs/connect@canary`
3. `node /home/tnunamak/code/vana-connect/dist/cli/bin.js` only for local development or debugging
