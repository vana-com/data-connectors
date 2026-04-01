#!/bin/bash
# setup-canary.sh — Install/uninstall/status for the connector smoke test canary.
#
# Usage:
#   ./ops/setup-canary.sh install     # install and start the launchd job
#   ./ops/setup-canary.sh uninstall   # stop and remove the launchd job
#   ./ops/setup-canary.sh status      # show if the job is loaded and recent logs
#   ./ops/setup-canary.sh test        # run the canary once manually

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.dataconnect.smoke-test-canary"
PLIST_SRC="$SCRIPT_DIR/com.dataconnect.smoke-test-canary.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/dataconnect"

case "${1:-help}" in
  install)
    # Create log dir
    mkdir -p "$LOG_DIR"

    # Create env file template if it doesn't exist
    ENV_FILE="$HOME/.dataconnect/canary.env"
    if [ ! -f "$ENV_FILE" ]; then
      mkdir -p "$HOME/.dataconnect"
      cat > "$ENV_FILE" << 'EOF'
# Connector smoke test canary — Slack configuration
# Get a webhook URL from: https://api.slack.com/messaging/webhooks
SLACK_WEBHOOK_URL=
EOF
      echo "Created $ENV_FILE — edit it to add your SLACK_WEBHOOK_URL"
    fi

    # Generate plist with resolved paths
    sed \
      -e "s|__REPO_DIR__|$REPO_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      "$PLIST_SRC" > "$PLIST_DST"

    # Make scripts executable
    chmod +x "$SCRIPT_DIR/smoke-test-canary.sh"

    # Unload first if already loaded
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

    # Load
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

    echo ""
    echo "✓ Installed and started: $LABEL"
    echo ""
    echo "  Runs every 8 hours (and once immediately on install)"
    echo "  Posts to Slack only on failure"
    echo ""
    echo "  Plist:   $PLIST_DST"
    echo "  Logs:    $LOG_DIR/"
    echo "  Config:  $ENV_FILE"
    echo ""
    echo "Next steps:"
    echo "  1. Edit $ENV_FILE and set SLACK_WEBHOOK_URL"
    echo "  2. Test manually: ./ops/setup-canary.sh test"
    echo ""
    ;;

  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "✓ Uninstalled: $LABEL"
    ;;

  status)
    if launchctl print "gui/$(id -u)/$LABEL" &>/dev/null; then
      echo "ACTIVE: $LABEL is loaded"
      launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|last exit|run count|interval" || true
    else
      echo "INACTIVE: $LABEL is not loaded"
    fi
    echo ""
    echo "Recent logs:"
    ls -lt "$LOG_DIR"/canary-*.stdout.log 2>/dev/null | head -3 || echo "  (none)"
    ;;

  test)
    echo "Running canary manually..."
    echo ""
    "$SCRIPT_DIR/smoke-test-canary.sh"
    ;;

  *)
    echo "Usage: $0 {install|uninstall|status|test}"
    echo ""
    echo "  install     Install launchd job (runs every 8h, posts to Slack on failure)"
    echo "  uninstall   Remove launchd job"
    echo "  status      Check if job is active and show recent logs"
    echo "  test        Run the canary once right now"
    exit 1
    ;;
esac
