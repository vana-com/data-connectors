# Connect -- Setup

This setup exists to let the skill use the published canary CLI:

```bash
pnpm dlx @opendatalabs/connect@canary
```

Skip runtime setup if `pnpm dlx @opendatalabs/connect@canary status --json` reports `"runtime":"installed"` or `"runtime":{"installed":true,...}`.

## Prerequisites

- Node.js v18+
- Git

## Verify the published CLI

```bash
pnpm dlx @opendatalabs/connect@canary --help
```

## Local development fallback

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

Use the published CLI to provision the runtime:

```bash
pnpm dlx @opendatalabs/connect@canary setup --yes
```

Before running, tell the user this downloads a browser engine and some dependencies into `~/.dataconnect/`. This is a one-time step.

## Verify

```bash
pnpm dlx @opendatalabs/connect@canary status
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
| `pnpm dlx @opendatalabs/connect@canary` | Published canary CLI entrypoint |
| `/home/tnunamak/code/vana-connect/dist/cli/bin.js` | Local development fallback |
| `~/.dataconnect/playwright-runner/` | Runner process |
| `~/.dataconnect/run-connector.cjs` | Batch-mode runner wrapper |
| `~/.dataconnect/connectors/` | Connector scripts |
| `~/.dataconnect/browser-profiles/` | Persistent sessions (cookies) |
| `~/.dataconnect/last-result.json` | Most recent result |
