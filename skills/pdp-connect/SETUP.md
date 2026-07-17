# Connect -- Setup

This repo bundles its own Playwright runner (`playwright-runner/`), so connectors run standalone -- no other repo required.

## Prerequisites

- Node.js
- `git` and (optionally) the `gh` CLI for contributing new connectors

## Install the runtime

```bash
bash skills/pdp-connect/scripts/setup.sh
```

This installs the bundled `playwright-runner/`'s dependencies (just Playwright) and downloads a Chromium build. This is a one-time step. Equivalent to running `npm install` inside `playwright-runner/` yourself.

## Verify

```bash
ls playwright-runner/index.cjs
ls playwright-runner/node_modules/playwright/package.json
```

If either is missing, re-run `setup.sh` and check its output for the step that failed.

## File Locations

| Path | Purpose |
|------|---------|
| `run-connector.cjs` (repo root, symlinked to `skills/pdp-connect/scripts/run-connector.cjs`) | Runs a connector headlessly |
| `playwright-runner/` (repo root) | Bundled runner the above resolves by default |
| `~/.pdp-connect/desktop/connectors/` | Connector scripts (when using the desktop app layout) |
| `~/.pdp-connect/desktop/browser-profiles/` | Persistent sessions (cookies) |
| `~/.pdp-connect/desktop/last-result.json` | Most recent result |
| `~/.pdp-connect/desktop/logs/` | Setup, fetch, and run logs |

## Optional: override the runner location

If you want to point at a different runner build (e.g. while developing the runner itself), pass `--runner-dir <path>` to `run-connector.cjs` or set `PLAYWRIGHT_RUNNER_DIR`. Neither is required for normal use.
