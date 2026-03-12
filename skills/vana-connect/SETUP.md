# Connect -- Setup

This setup exists to let the skill use the built local CLI at:

```bash
node /home/tnunamak/code/vana-connect/dist/cli/bin.js
```

Skip runtime setup if `node /home/tnunamak/code/vana-connect/dist/cli/bin.js status --json` reports `"runtime":{"installed":true,...}`.

## Prerequisites

- Node.js v18+
- Git

## Build the CLI

From `/home/tnunamak/code/vana-connect`:

```bash
pnpm install
pnpm build
```

Verify:

```bash
ls /home/tnunamak/code/vana-connect/dist/cli/bin.js
```

## Install the runtime

Once the CLI is built, use it to provision the runtime:

```bash
node /home/tnunamak/code/vana-connect/dist/cli/bin.js setup --yes
```

Before running, tell the user this downloads a browser engine and some dependencies into `~/.dataconnect/`. This is a one-time step.

## Verify

```bash
node /home/tnunamak/code/vana-connect/dist/cli/bin.js status
```

You should see `Runtime: installed`. If not, inspect the log path surfaced by the CLI and only fall back to the older script-level flow if the CLI setup path is blocked.

## Legacy fallback

Only use this if the CLI setup path is broken and you are debugging the underlying runtime:

```bash
bash skills/vana-connect/scripts/setup.sh
```

## File Locations

| Path | Purpose |
|------|---------|
| `/home/tnunamak/code/vana-connect/dist/cli/bin.js` | Local development CLI entrypoint |
| `~/.dataconnect/playwright-runner/` | Runner process |
| `~/.dataconnect/run-connector.cjs` | Batch-mode runner wrapper |
| `~/.dataconnect/connectors/` | Connector scripts |
| `~/.dataconnect/browser-profiles/` | Persistent sessions (cookies) |
| `~/.dataconnect/last-result.json` | Most recent result |
