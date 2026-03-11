# Connect -- Setup

Skip if `~/.dataconnect/playwright-runner/index.cjs` and `~/.dataconnect/run-connector.cjs` both exist.

## Prerequisites

- Node.js v18+
- Git

## Install

Run the setup script from the data-connectors repo root:

```bash
bash skills/vana-connect/scripts/setup.sh
```

This installs the playwright-runner, Chromium, and run-connector.cjs in a single step. If the user needs to approve commands, this is one approval instead of many.

**Before running**, tell the user: setup will download a browser engine and some Node.js dependencies into `~/.dataconnect/`. This is a one-time step.

## Manual install

If the setup script doesn't work for your environment, follow these steps individually:

```bash
mkdir -p ~/.dataconnect/connectors
cd ~/.dataconnect

git clone --depth 1 --filter=blob:none --sparse --branch docs/upstream-asks \
  https://github.com/vana-com/data-connect.git _data-connect
cd _data-connect && git sparse-checkout set playwright-runner
cp -r playwright-runner ../playwright-runner
cd .. && rm -rf _data-connect
cd ~/.dataconnect/playwright-runner && npm install
npx playwright install chromium
```

Then copy run-connector.cjs from the skill's scripts/ directory:

```bash
cp skills/vana-connect/scripts/run-connector.cjs ~/.dataconnect/run-connector.cjs
```

> **Do not** use `curl` to fetch this file from GitHub — the repo root contains a symlink that GitHub raw serves as a text pointer, not the actual script.

## Verify

```bash
ls ~/.dataconnect/playwright-runner/index.cjs ~/.dataconnect/run-connector.cjs
```

Both files should exist.

## File Locations

| Path | Purpose |
|------|---------|
| `~/.dataconnect/playwright-runner/` | Runner process |
| `~/.dataconnect/run-connector.cjs` | Batch-mode runner wrapper |
| `~/.dataconnect/connectors/` | Connector scripts |
| `~/.dataconnect/browser-profiles/` | Persistent sessions (cookies) |
| `~/.dataconnect/last-result.json` | Most recent result |
