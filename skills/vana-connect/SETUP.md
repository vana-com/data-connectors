# Connect -- Setup

Skip if `~/.dataconnect/playwright-runner/index.cjs` and `~/.dataconnect/run-connector.cjs` both exist.

## Prerequisites

- Node.js v18+
- Git

## Install playwright-runner + Chromium

```bash
mkdir -p ~/.dataconnect/connectors
cd ~/.dataconnect

git clone --depth 1 --filter=blob:none --sparse --branch docs/upstream-asks \
  https://github.com/vana-com/data-connect.git _data-connect
cd _data-connect && git sparse-checkout set playwright-runner
cp -r playwright-runner ../playwright-runner
cd .. && rm -rf _data-connect
cd ~/.dataconnect/playwright-runner && npm install
npx playwright install --with-deps chromium
```

## Install run-connector.cjs

Copy from the skill's `scripts/` directory — this is in the same `data-connectors` repo you cloned to read this skill. The path relative to the repo root is `skills/vana-connect/scripts/run-connector.cjs`.

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
