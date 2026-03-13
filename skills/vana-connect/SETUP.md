# Connect -- Setup

This setup exists to let the skill use a real installed `vana` CLI when available, with the published canary CLI as the fallback.

## Preferred path

If `vana` is already on `PATH`, use it directly:

```bash
command -v vana
```

Then use:

```bash
vana
```

Skip runtime setup if `vana status --json` reports `"runtime":"installed"` or `"runtime":{"installed":true,...}`.

## Fallback path

If `vana` is not installed yet, prefer the official installer so the user gets a real installed CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/vana-com/vana-connect/main/install/install.sh | sh
```

Then verify:

```bash
vana --help
```

If the installer path is unavailable or the released CLI does not yet contain the needed behavior, use the published canary package:

```bash
npx -y @opendatalabs/connect@canary
```

Skip runtime setup if `npx -y @opendatalabs/connect@canary status --json` reports `"runtime":"installed"` or `"runtime":{"installed":true,...}`.

## Verify the published CLI

```bash
npx -y @opendatalabs/connect@canary --help
```

## Verify an installed CLI

```bash
vana --help
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

Use the installed CLI when possible:

```bash
vana setup --yes
```

If `vana` is not installed, use the published canary fallback:

```bash
npx -y @opendatalabs/connect@canary --help
npx -y @opendatalabs/connect@canary setup --yes
```

Before running, tell the user this downloads a browser engine and some dependencies into `~/.dataconnect/`. This is a one-time step.

## Verify

```bash
vana status
```

You should see `Runtime: installed`. If `vana` is unavailable, run `npx -y @opendatalabs/connect@canary status` instead.
If setup still fails, inspect the log path surfaced by the CLI and only fall back to the older script-level flow if the CLI setup path is blocked.

## Legacy fallback

Only use this if the CLI setup path is broken and you are debugging the underlying runtime:

```bash
bash skills/vana-connect/scripts/setup.sh
```

## File Locations

| Path | Purpose |
|------|---------|
| `vana` | Preferred installed CLI entrypoint |
| `npx -y @opendatalabs/connect@canary` | Published canary CLI entrypoint |
| `/home/tnunamak/code/vana-connect/dist/cli/bin.js` | Local development fallback |
| `~/.dataconnect/connectors/` | Connector scripts |
| `~/.dataconnect/browser-profiles/` | Persistent sessions (cookies) |
| `~/.dataconnect/last-result.json` | Most recent result |
| `~/.dataconnect/logs/` | Setup and run logs surfaced by the CLI |
