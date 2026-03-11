#!/bin/bash

# Autonomous Data Connector Creator
#
# Creates, tests, and validates a data connector — fully automated, no human needed.
# Uses Claude Code as the AI backbone. Credentials come from .env.
#
# Usage:
#   ./create-connector.sh <platform> [description]
#
# Examples:
#   ./create-connector.sh instagram
#   ./create-connector.sh reddit "Extract saved posts, comments, and karma history"
#   ./create-connector.sh notion "Export all pages and databases"

set -e

PLATFORM="${1:?Usage: ./create-connector.sh <platform> [description...]}"
shift
DESCRIPTION="$*"

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

# Run Claude Code from the harness directory
cd "$SCRIPT_DIR"

# --allowedTools: pre-approve all tools the agent needs (avoids permission prompts in -p mode)
# --output-format stream-json: stream events as they happen
# Pipe through formatter for human-readable logs
claude -p "$PROMPT" \
  --allowedTools "Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch,Agent" \
  --output-format stream-json \
  --verbose \
  | node scripts/format-stream.cjs
