#!/usr/bin/env bash
# setup.sh — One-shot setup for the pdp-connect skill.
# Installs playwright-runner, Chromium, and run-connector.cjs.
#
# Usage: bash scripts/setup.sh
#   Run from the data-connectors repo root (where skills/ lives).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PDP_CONNECT_DIR="$HOME/.pdp-connect/desktop"

# Skip if already set up
if [[ -f "$PDP_CONNECT_DIR/playwright-runner/index.cjs" && -f "$PDP_CONNECT_DIR/run-connector.cjs" ]]; then
  echo "Already set up. To reinstall, remove ~/.pdp-connect/desktop/playwright-runner/ first."
  exit 0
fi

echo "Setting up pdp-connect..."

mkdir -p "$PDP_CONNECT_DIR/connectors"

# 1. Clone playwright-runner (sparse checkout, minimal download)
echo "Downloading playwright-runner..."
cd "$PDP_CONNECT_DIR"
rm -rf _data-connect
git clone --depth 1 --filter=blob:none --sparse --branch main \
  https://github.com/vana-com/data-connect.git _data-connect 2>&1
cd _data-connect && git sparse-checkout set playwright-runner 2>&1
cp -r playwright-runner ../playwright-runner
cd .. && rm -rf _data-connect

# 2. Install dependencies
echo "Installing dependencies..."
cd "$PDP_CONNECT_DIR/playwright-runner" && npm install 2>&1

# 3. Install Chromium
echo "Installing Chromium (this may take a minute)..."
npx playwright install chromium 2>&1 || {
  echo "Note: 'playwright install --with-deps' may need root. Trying without system deps..."
  npx playwright install chromium 2>&1 || true
}

# 4. Copy run-connector.cjs
if [[ -f "$SCRIPT_DIR/run-connector.cjs" ]]; then
  cp "$SCRIPT_DIR/run-connector.cjs" "$PDP_CONNECT_DIR/run-connector.cjs"
else
  echo "Warning: run-connector.cjs not found at $SCRIPT_DIR/run-connector.cjs"
  echo "Copy it manually: cp skills/pdp-connect/scripts/run-connector.cjs ~/.pdp-connect/desktop/run-connector.cjs"
fi

# Verify
echo ""
if [[ -f "$PDP_CONNECT_DIR/playwright-runner/index.cjs" && -f "$PDP_CONNECT_DIR/run-connector.cjs" ]]; then
  echo "Setup complete!"
else
  echo "Setup may be incomplete. Check ~/.pdp-connect/desktop/ for missing files."
  exit 1
fi
