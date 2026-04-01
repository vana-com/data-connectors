#!/bin/bash
# smoke-test-canary.sh — Run connector smoke test, post to Slack on failure only.
#
# Required env vars (set in ~/.dataconnect/canary.env or export before running):
#   SLACK_WEBHOOK_URL   — Slack incoming webhook for #eng_alerts
#
# Optional env vars:
#   DATACONNECT_REPO    — Path to data-connectors repo (default: script's parent dir)
#   NODE_PATH_OVERRIDE  — Explicit node binary path (default: /opt/homebrew/bin/node)

set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${DATACONNECT_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
NODE_BIN="${NODE_PATH_OVERRIDE:-/opt/homebrew/bin/node}"
LOG_DIR="$HOME/Library/Logs/dataconnect"
HOSTNAME="$(hostname -s)"

# ─── Load env vars from config file if present ───────────────

ENV_FILE="$HOME/.dataconnect/canary.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# ─── Validate ────────────────────────────────────────────────

if [ ! -f "$REPO_DIR/scripts/test-connectors.cjs" ]; then
  echo "ERROR: test-connectors.cjs not found at $REPO_DIR/scripts/"
  exit 1
fi

if [ ! -x "$NODE_BIN" ] && ! command -v "$NODE_BIN" &>/dev/null; then
  echo "ERROR: node not found at $NODE_BIN"
  exit 1
fi

# ─── Set up logging ──────────────────────────────────────────

mkdir -p "$LOG_DIR"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
STDOUT_LOG="$LOG_DIR/canary-${RUN_ID}.stdout.log"
STDERR_LOG="$LOG_DIR/canary-${RUN_ID}.stderr.log"

# ─── Run harness ─────────────────────────────────────────────

cd "$REPO_DIR"

EXIT_CODE=0
"$NODE_BIN" scripts/test-connectors.cjs \
  >"$STDOUT_LOG" 2>"$STDERR_LOG" || EXIT_CODE=$?

# ─── Exit quietly on success ─────────────────────────────────

if [ "$EXIT_CODE" -eq 0 ]; then
  exit 0
fi

# ─── Parse report for Slack message ──────────────────────────

# Find the latest report JSON
REPORT_PATH=""
if [ -d "$REPO_DIR/test-results" ]; then
  REPORT_PATH="$(ls -t "$REPO_DIR/test-results"/connector-smoke-*.json 2>/dev/null | head -1)"
fi

# Build Slack message from report JSON if available
if [ -n "$REPORT_PATH" ] && [ -f "$REPORT_PATH" ]; then
  SLACK_TEXT=$("$NODE_BIN" -e "
    const r = JSON.parse(require('fs').readFileSync('$REPORT_PATH', 'utf-8'));
    const s = r.summary;
    const parts = [];
    if (s.pass) parts.push(s.pass + ' pass');
    if (s.warn) parts.push(s.warn + ' warn');
    if (s.auth) parts.push(s.auth + ' auth');
    if (s.fail) parts.push(s.fail + ' fail');
    if (s.timeout) parts.push(s.timeout + ' timeout');
    const summary = parts.join(', ');

    const failures = r.results.filter(c => c.status !== 'pass' && c.status !== 'warn');
    const lines = failures.map(c => {
      const status = c.status.toUpperCase();
      let detail = c.error || '';
      if (c.scopesMissing && c.scopesMissing.length > 0) detail = 'missing: ' + c.scopesMissing.join(', ');
      const note = c.status === 'auth' ? ' _(likely stale session)_' : '';
      return '• ' + c.connector + ': *' + status + '*' + note + (detail ? ' — ' + detail : '');
    }).join('\n');

    const msg = [
      '*Connector smoke test failed* on \`${HOSTNAME}\`',
      '',
      '*Summary:* ' + summary,
      '',
      '*Failures:*',
      lines,
      '',
      '_Report: \`${REPORT_PATH}\`_',
    ].join('\n');

    process.stdout.write(msg);
  " 2>/dev/null)
else
  # No report — fall back to basic message
  SLACK_TEXT="*Connector smoke test failed* on \`${HOSTNAME}\`

*Exit code:* ${EXIT_CODE}
*No report generated* — check logs at \`${LOG_DIR}/canary-${RUN_ID}.*\`"
fi

# ─── Post to Slack ───────────────────────────────────────────

if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "WARNING: SLACK_WEBHOOK_URL not set — skipping Slack notification"
  echo "Slack message would have been:"
  echo "$SLACK_TEXT"
  exit "$EXIT_CODE"
fi

PAYLOAD=$("$NODE_BIN" -e "
  process.stdout.write(JSON.stringify({ text: $(echo "$SLACK_TEXT" | "$NODE_BIN" -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf-8')))") }));
")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H 'Content-type: application/json' \
  --data "$PAYLOAD" \
  "$SLACK_WEBHOOK_URL")

if [ "$HTTP_CODE" != "200" ]; then
  echo "WARNING: Slack post returned HTTP $HTTP_CODE" >> "$STDERR_LOG"
fi

# ─── Exit with original failure code ─────────────────────────

exit "$EXIT_CODE"
