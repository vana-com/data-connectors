#!/bin/bash

# Autonomous Data Connector Creator
#
# Creates, tests, and validates a data connector for any web platform.
# Uses Claude Code as the AI backbone to drive the full workflow.
# Login is fully automated via credentials in .env — no human interaction needed.
#
# Usage:
#   ./create-connector.sh <platform> [description]
#
# Examples:
#   ./create-connector.sh twitter
#   ./create-connector.sh reddit "Extract saved posts, comments, and karma history"
#   ./create-connector.sh notion "Export all pages and databases"
#
# Prerequisites:
#   - Claude Code CLI: npm install -g @anthropic-ai/claude-code
#   - Credentials in .env: USER_LOGIN_<PLATFORM> and USER_PASSWORD_<PLATFORM>
#   - Playwright runner: ../data-dt-app/playwright-runner/ or PLAYWRIGHT_RUNNER_DIR

set -e

PLATFORM="${1:?Usage: ./create-connector.sh <platform> [description]}"
DESCRIPTION="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORM_UPPER=$(echo "$PLATFORM" | tr '[:lower:]' '[:upper:]')

echo "╔══════════════════════════════════════════════╗"
echo "║   Autonomous Data Connector Creator          ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Platform:    ${PLATFORM}"
echo "║  Description: ${DESCRIPTION:-<auto-detect>}"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Load .env if it exists
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
  echo "Loaded .env"
else
  echo "Warning: No .env file found. Create one with credentials:"
  echo "  USER_LOGIN_${PLATFORM_UPPER}=your_username"
  echo "  USER_PASSWORD_${PLATFORM_UPPER}=your_password"
  echo ""
fi

# Check credentials
LOGIN_VAR="USER_LOGIN_${PLATFORM_UPPER}"
PASSWORD_VAR="USER_PASSWORD_${PLATFORM_UPPER}"

if [ -z "${!LOGIN_VAR}" ] || [ -z "${!PASSWORD_VAR}" ]; then
  echo "Warning: Credentials not found for ${PLATFORM}."
  echo "  Expected: ${LOGIN_VAR} and ${PASSWORD_VAR} in .env"
  echo ""
fi

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
  echo "Error: 'claude' CLI not found. Install Claude Code first:"
  echo "  npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# Check if playwright-runner is available
RUNNER_FOUND=false
for DIR in \
  "${PLAYWRIGHT_RUNNER_DIR}" \
  "${SCRIPT_DIR}/../data-dt-app/playwright-runner" \
  "${HOME}/Documents/GitHub/data-dt-app/playwright-runner" \
  "${HOME}/code/data-dt-app/playwright-runner" \
  "${HOME}/src/data-dt-app/playwright-runner"; do
  if [ -n "$DIR" ] && [ -f "$DIR/index.cjs" ]; then
    RUNNER_FOUND=true
    break
  fi
done

if [ "$RUNNER_FOUND" = false ]; then
  echo "Warning: playwright-runner not found. The test step will fail."
  echo "  Set PLAYWRIGHT_RUNNER_DIR or clone data-dt-app next to this repo."
  echo ""
fi

# Build the prompt
PROMPT="Create a data connector for ${PLATFORM}."

if [ -n "$DESCRIPTION" ]; then
  PROMPT="${PROMPT} Data to extract: ${DESCRIPTION}."
fi

PROMPT="${PROMPT}

Read and follow the autonomous workflow in .claude/skills/auto-create-connector/SKILL.md
Execute ALL steps: research, create, validate structure, test (headless), validate output, iterate if needed, finalize.
Credentials are available in process.env as USER_LOGIN_${PLATFORM_UPPER} and USER_PASSWORD_${PLATFORM_UPPER}.
Do not stop until the connector passes all validation checks or you've exhausted 3 iteration attempts."

cd "$SCRIPT_DIR"

# Launch Claude Code
claude -p "$PROMPT"
