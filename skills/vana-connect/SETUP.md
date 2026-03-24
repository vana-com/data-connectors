# Connect -- Setup

This setup exists to let the skill use an installed `vana` CLI.

```bash
command -v vana
```

Skip runtime setup if `vana status --json` reports `"runtime":"installed"` or `"runtime":{"installed":true,...}`.

## Prerequisites

For the normal installed CLI path:

- Homebrew on macOS, or
- `curl` and `sh` on macOS/Linux

Only local development and `npx` fallback require Node.js.

## Install the published CLI

Preferred on macOS:

```bash
brew tap vana-com/vana
brew install vana
```

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/vana-com/vana-connect/feat/connect-cli-v1/install/install.sh | sh -s -- --version canary-feat-connect-cli-v1
```

Fallback if installer paths are blocked:

```bash
npx -y @opendatalabs/connect@canary --help
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
vana setup --yes
```

Before running, tell the user this downloads a browser engine and some dependencies into `~/.dataconnect/`. This is a one-time step.

## Verify

```bash
vana status
vana doctor
vana logs
```

You should see `Runtime: installed`. If not, inspect the log path surfaced by the CLI or use `vana logs`, and only fall back to the older script-level flow if the CLI setup path is blocked.

## Legacy fallback

Only use this if the CLI setup path is broken and you are debugging the underlying runtime:

```bash
bash skills/vana-connect/scripts/setup.sh
```

## File Locations

| Path | Purpose |
|------|---------|
| `vana` | Preferred installed CLI entrypoint |
| `npx -y @opendatalabs/connect@canary` | Published canary CLI fallback |
| `/home/tnunamak/code/vana-connect/dist/cli/bin.js` | Local development fallback |
| `~/.local/share/vana/` | Hosted-installer release payloads |
| `~/.dataconnect/connectors/` | Connector scripts |
| `~/.dataconnect/browser-profiles/` | Persistent sessions (cookies) |
| `~/.dataconnect/last-result.json` | Most recent result |
| `~/.dataconnect/logs/` | Setup, fetch, and run logs |
