# Connect -- Setup

This setup provisions the local runtime the in-repo scripts use to run connectors headlessly.

## Prerequisites

- Node.js
- `git` and (optionally) the `gh` CLI for contributing new connectors

## Install the runtime

```bash
bash skills/pdp-connect/scripts/setup.sh
```

This downloads the `playwright-runner` and a Chromium build into `~/.pdp-connect/desktop/`. This is a one-time step.

## Verify

```bash
ls ~/.pdp-connect/desktop/playwright-runner/index.cjs
ls ~/.pdp-connect/desktop/run-connector.cjs
```

If either is missing, re-run `setup.sh` and check its output for the step that failed.

## File Locations

| Path | Purpose |
|------|---------|
| `run-connector.cjs` (repo root, symlinked to `skills/pdp-connect/scripts/run-connector.cjs`) | Runs a connector headlessly |
| `~/.pdp-connect/desktop/connectors/` | Connector scripts |
| `~/.pdp-connect/desktop/browser-profiles/` | Persistent sessions (cookies) |
| `~/.pdp-connect/desktop/last-result.json` | Most recent result |
| `~/.pdp-connect/desktop/logs/` | Setup, fetch, and run logs |
