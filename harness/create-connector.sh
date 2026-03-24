#!/bin/bash

# Autonomous Data Connector Creator
#
# Creates, tests, and validates a data connector — end to end.
# Handles session capture (manual login) when needed, then uses Claude Code
# to autonomously build the connector.
#
# Usage:
#   ./create-connector.sh <platform> [options] [description]
#
# Options:
#   --login-url URL   Login URL for session capture (skips prompt)
#   --skip-session    Skip session capture even if no credentials
#   --session-only    Only capture session, don't build connector
#
# Examples:
#   ./create-connector.sh instagram
#   ./create-connector.sh uber --login-url https://auth.uber.com
#   ./create-connector.sh google --login-url https://accounts.google.com "Export contacts and calendar"
#   ./create-connector.sh reddit "Extract saved posts and comment history"

set -e

# ─── Parse Arguments ─────────────────────────────────────────

PLATFORM=""
LOGIN_URL=""
DESCRIPTION=""
SKIP_SESSION=false
SESSION_ONLY=false
FORCE_SESSION=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --login-url)
      LOGIN_URL="$2"
      shift 2
      ;;
    --skip-session)
      SKIP_SESSION=true
      shift
      ;;
    --session-only)
      SESSION_ONLY=true
      shift
      ;;
    --force-session)
      FORCE_SESSION=true
      shift
      ;;
    --help|-h)
      echo "Usage: ./create-connector.sh <platform> [options] [description]"
      echo ""
      echo "Options:"
      echo "  --login-url URL   Login URL for session capture"
      echo "  --skip-session    Skip session capture"
      echo "  --session-only    Only capture session, don't build connector"
      echo ""
      echo "Examples:"
      echo "  ./create-connector.sh instagram"
      echo "  ./create-connector.sh uber --login-url https://auth.uber.com"
      echo "  ./create-connector.sh google --login-url https://accounts.google.com \"Export contacts\""
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      exit 1
      ;;
    *)
      if [ -z "$PLATFORM" ]; then
        PLATFORM="$1"
      else
        DESCRIPTION="${DESCRIPTION:+$DESCRIPTION }$1"
      fi
      shift
      ;;
  esac
done

if [ -z "$PLATFORM" ]; then
  echo "Error: Platform name required."
  echo "Usage: ./create-connector.sh <platform> [options] [description]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORM_UPPER=$(echo "$PLATFORM" | tr '[:lower:]' '[:upper:]')

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Data Connector Creator                     ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Platform:    ${PLATFORM}"
echo "║  Description: ${DESCRIPTION:-<auto-detect>}"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ─── Load .env ───────────────────────────────────────────────

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# ─── Check Auth State ───────────────────────────────────────

LOGIN_VAR="USER_LOGIN_${PLATFORM_UPPER}"
PASSWORD_VAR="USER_PASSWORD_${PLATFORM_UPPER}"
HAS_CREDENTIALS=false
HAS_SESSION=false

if [ -n "${!LOGIN_VAR}" ] && [ -n "${!PASSWORD_VAR}" ]; then
  HAS_CREDENTIALS=true
fi

PROFILE_DIR="$HOME/.dataconnect/browser-profiles/${PLATFORM}-playwright"
if [ -d "$PROFILE_DIR" ]; then
  HAS_SESSION=true
fi

echo "Auth status:"
if $HAS_SESSION; then
  echo "  ✓ Browser session exists: ${PROFILE_DIR}"
fi
if $HAS_CREDENTIALS; then
  echo "  ✓ Credentials found in .env"
fi
if ! $HAS_SESSION && ! $HAS_CREDENTIALS; then
  echo "  ✗ No session or credentials found"
fi
echo ""

# ─── Session Capture (if needed) ─────────────────────────────

NEEDS_SESSION=false

if ! $SKIP_SESSION; then
  if $FORCE_SESSION && [ -n "$LOGIN_URL" ]; then
    # Explicit force re-capture
    NEEDS_SESSION=true
  elif ! $HAS_SESSION && ! $HAS_CREDENTIALS; then
    # No auth at all — need session capture
    NEEDS_SESSION=true
  elif ! $HAS_SESSION && [ -n "$LOGIN_URL" ]; then
    # No session but login URL provided — capture it
    NEEDS_SESSION=true
  fi
fi

if $NEEDS_SESSION; then
  # If no login URL provided, ask for it
  if [ -z "$LOGIN_URL" ]; then
    echo "No credentials or session found for ${PLATFORM}."
    echo "Session capture will open a browser for you to log in manually."
    echo ""
    read -p "Enter the login URL for ${PLATFORM} (e.g., https://${PLATFORM}.com/login): " LOGIN_URL
    echo ""
  fi

  if [ -z "$LOGIN_URL" ]; then
    echo "Error: Login URL is required for session capture."
    echo "  Either provide --login-url or add credentials to .env:"
    echo "    ${LOGIN_VAR}=your_username"
    echo "    ${PASSWORD_VAR}=your_password"
    exit 1
  fi

  echo "─── Session Capture ───────────────────────────"
  echo "  Opening browser for ${PLATFORM} login..."
  echo "  URL: ${LOGIN_URL}"
  echo "  Log in manually. Session will be detected automatically."
  echo "───────────────────────────────────────────────"
  echo ""

  cd "$SCRIPT_DIR"
  node capture-session.cjs "$PLATFORM" "$LOGIN_URL" --timeout 300

  CAPTURE_EXIT=$?
  if [ $CAPTURE_EXIT -ne 0 ]; then
    echo ""
    echo "Session capture failed. You can retry with:"
    echo "  node capture-session.cjs $PLATFORM $LOGIN_URL --timeout 600"
    exit 1
  fi

  echo ""
  HAS_SESSION=true
fi

# ─── Session-only mode ──────────────────────────────────────

if $SESSION_ONLY; then
  echo "Session captured. Exiting (--session-only mode)."
  exit 0
fi

# ─── Find Claude CLI ────────────────────────────────────────

CLAUDE_BIN=""
if command -v claude &> /dev/null; then
  CLAUDE_BIN="claude"
else
  # Search common NVM / node locations
  for candidate in \
    "$HOME/.nvm/versions/node"/*/bin/claude \
    /usr/local/bin/claude \
    "$HOME/.npm-global/bin/claude" \
    "$HOME/.local/bin/claude"; do
    if [ -x "$candidate" ] 2>/dev/null; then
      CLAUDE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$CLAUDE_BIN" ]; then
  echo "Error: 'claude' CLI not found. Install Claude Code first:"
  echo "  npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# ─── Build Prompt ────────────────────────────────────────────

PROMPT="Create a data connector for ${PLATFORM}."

if [ -n "$DESCRIPTION" ]; then
  PROMPT="${PROMPT} Data to extract: ${DESCRIPTION}."
fi

# Tell the agent about auth state
AUTH_INFO=""
if $HAS_SESSION; then
  AUTH_INFO="A browser session has been pre-captured at ${PROFILE_DIR}. The connector will automatically reuse it (Tier 1 login). You can test with --headless and the session will be restored."
fi
if $HAS_CREDENTIALS; then
  AUTH_INFO="${AUTH_INFO} Credentials are available in process.env as USER_LOGIN_${PLATFORM_UPPER} and USER_PASSWORD_${PLATFORM_UPPER}."
fi

PROMPT="${PROMPT}

${AUTH_INFO}

IMPORTANT: You are running from the harness/ directory. Connector files go in the PARENT directory:
- Connector: ../${PLATFORM}/${PLATFORM}-playwright.js and ../${PLATFORM}/${PLATFORM}-playwright.json
- Schemas: ../schemas/${PLATFORM}.<scope>.json
- Registry: ../registry.json
Do NOT create files inside harness/. Use ../ paths for all connector output.

Read and follow the autonomous workflow in .claude/skills/auto-create-connector/SKILL.md
Execute ALL steps: research, create, validate structure, test (headless), validate output, iterate if needed, finalize (including registry update).
Skip Step 1.5 (session capture) — session is already handled.
Do not stop until the connector passes all validation checks or you've exhausted 3 iteration attempts."

# ─── Run Claude Agent ───────────────────────────────────────

echo "─── Building Connector ────────────────────────"
echo "  Launching Claude agent..."
echo "───────────────────────────────────────────────"
echo ""

cd "$SCRIPT_DIR"

"$CLAUDE_BIN" -p "$PROMPT" \
  --allowedTools "Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch,Agent" \
  --output-format stream-json \
  --verbose \
  | node scripts/format-stream.cjs
