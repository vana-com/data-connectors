# Connector Smoke Test Canary

Runs the connector smoke test every 8 hours on your Mac and posts to Slack `#eng_alerts` when something breaks. Silent on success.

## Prerequisites

- Node.js installed (`/opt/homebrew/bin/node` or set `NODE_PATH_OVERRIDE`)
- playwright-runner installed at `~/.dataconnect/playwright-runner/` (comes with the DataConnect app)
- Logged into the relevant services (ChatGPT, GitHub, Instagram, LinkedIn, Spotify, Oura) in your system Chrome

## Setup

```bash
# 1. Install the scheduled job
./ops/setup-canary.sh install

# 2. Edit the config file it created and add your Slack webhook URL
#    Get one from: https://api.slack.com/messaging/webhooks
nano ~/.dataconnect/canary.env

# 3. Test it works
./ops/setup-canary.sh test
```

## Commands

```bash
./ops/setup-canary.sh install     # install and start (runs every 8h + once now)
./ops/setup-canary.sh uninstall   # stop and remove
./ops/setup-canary.sh status      # check if active, show recent logs
./ops/setup-canary.sh test        # run once manually
```

## Logs

`~/Library/Logs/dataconnect/canary-*.log`

## How it works

1. launchd triggers `ops/smoke-test-canary.sh` every 8 hours
2. The wrapper runs `node scripts/test-connectors.cjs` (all stable connectors)
3. If exit code is 0 (all pass) → does nothing
4. If exit code is non-zero → parses the JSON report, builds a Slack message with failing connectors, posts to `#eng_alerts`

## Troubleshooting

**AUTH failures:** A connector's Chrome session expired. Log into that service in Chrome, then clear the stale cookie marker:
```bash
rm ~/.dataconnect/browser-profiles/<connector-name>/.cookies-imported
```

**"node not found":** Set `NODE_PATH_OVERRIDE` in `~/.dataconnect/canary.env` to your node binary path.

**"SLACK_WEBHOOK_URL not set":** Edit `~/.dataconnect/canary.env` and add your webhook URL.
