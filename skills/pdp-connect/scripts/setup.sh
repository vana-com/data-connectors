#!/usr/bin/env bash
# setup.sh — One-shot setup for the pdp-connect skill.
# Installs the bundled playwright-runner's dependencies and Chromium.
#
# Usage: bash skills/pdp-connect/scripts/setup.sh
#   Run from the data-connectors repo root (where playwright-runner/ lives).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER_DIR="$REPO_ROOT/playwright-runner"

if [[ ! -f "$RUNNER_DIR/index.cjs" ]]; then
  echo "Could not find playwright-runner/ at $RUNNER_DIR — is this the data-connectors repo root?"
  exit 1
fi

# Skip if already set up
if [[ -f "$RUNNER_DIR/node_modules/playwright/package.json" ]]; then
  echo "Already set up. To reinstall, remove $RUNNER_DIR/node_modules/ first."
  exit 0
fi

echo "Setting up the bundled playwright-runner..."

# 1. Install runner dependencies (just playwright)
echo "Installing dependencies..."
cd "$RUNNER_DIR" && npm install 2>&1

# 2. Install Chromium (also runs automatically via the runner's postinstall hook)
echo "Installing Chromium (this may take a minute)..."
npx playwright install chromium 2>&1 || {
  echo "Note: Chromium install may need extra system deps. Trying 'playwright install-deps'..."
  npx playwright install-deps chromium 2>&1 || true
  npx playwright install chromium 2>&1 || true
}

# Verify
echo ""
if [[ -d "$RUNNER_DIR/node_modules/playwright" ]]; then
  echo "Setup complete! The bundled runner at $RUNNER_DIR is ready."
else
  echo "Setup may be incomplete. Check $RUNNER_DIR for missing files."
  exit 1
fi
