# Connect -- Setup

Skip if `~/.dataconnect/playwright-runner/index.cjs` and `~/.dataconnect/run-connector.cjs` both exist.

## Prerequisites

- Node.js v18+
- Git

## Install playwright-runner + Chromium

```bash
mkdir -p ~/.dataconnect/connectors
cd ~/.dataconnect

git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/vana-com/data-connect.git _data-connect
cd _data-connect && git sparse-checkout set playwright-runner
cp -r playwright-runner ../playwright-runner
cd .. && rm -rf _data-connect
cd ~/.dataconnect/playwright-runner && npm install
npx playwright install --with-deps chromium
```

## Install run-connector.cjs

```bash
curl -sL https://raw.githubusercontent.com/vana-com/data-connectors/main/skills/vana-connect/scripts/run-connector.cjs \
  > ~/.dataconnect/run-connector.cjs
```

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
